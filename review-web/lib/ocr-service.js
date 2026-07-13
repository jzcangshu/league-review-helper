const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const inflight = new Map();
let runtimePromise = null;

function parseOcrOutput(stdout) {
  const value = String(stdout || "").replace(/^\uFEFF/, "").trim();
  if (!value) throw new Error("OCR 没有返回识别结果。");
  return JSON.parse(value);
}

async function cacheKey(pdfPath) {
  const stats = await fsp.stat(pdfPath);
  return crypto.createHash("sha1")
    .update(`${path.resolve(pdfPath)}\n${stats.size}\n${stats.mtimeMs}\nppocrv6-small-det-tiny-rec-scale35-v2`)
    .digest("hex");
}

async function checkRuntime(pythonPath) {
  await execFileAsync(pythonPath, [
    "-X", "utf8", "-c",
    "from paddleocr import TextDetection, TextRecognition; import fitz, onnxruntime"
  ], { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
}

async function findBasePython() {
  for (const candidate of [
    { file: "python", prefix: [] },
    { file: "py", prefix: ["-3"] }
  ]) {
    try {
      await execFileAsync(candidate.file, [...candidate.prefix, "--version"], { windowsHide: true, timeout: 10000 });
      return candidate;
    } catch {}
  }
  throw new Error("首次启用高级 OCR 需要 Python 3.10 或更高版本，请先安装 Python。");
}

async function ensureRuntime(runtimeRoot) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const pythonPath = path.join(runtimeRoot, "Scripts", "python.exe");
    try {
      await checkRuntime(pythonPath);
      return pythonPath;
    } catch {}

    const base = await findBasePython();
    try {
      await fsp.access(pythonPath);
    } catch {
      await execFileAsync(base.file, [...base.prefix, "-m", "venv", runtimeRoot, "--system-site-packages"], {
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024
      });
    }
    const requirements = [
      "paddleocr==3.7.0",
      "paddlex[ocr-core]==3.7.2",
      "onnxruntime>=1.23",
      "PyMuPDF>=1.24"
    ];
    const installArgs = ["-m", "pip", "install", ...requirements];
    try {
      await execFileAsync(pythonPath, [...installArgs, "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"], {
        windowsHide: true,
        timeout: 900000,
        maxBuffer: 32 * 1024 * 1024
      });
    } catch {
      await execFileAsync(pythonPath, installArgs, {
        windowsHide: true,
        timeout: 900000,
        maxBuffer: 32 * 1024 * 1024
      });
    }
    await checkRuntime(pythonPath);
    return pythonPath;
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

async function runPaddleOcr(pdfPath, options) {
  const pythonPath = await ensureRuntime(options.runtimeRoot);
  const { stdout } = await execFileAsync(pythonPath, [
    "-X", "utf8",
    options.scriptPath,
    "--pdf", pdfPath
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PADDLE_PDX_MODEL_SOURCE: "BOS",
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
      PADDLE_PDX_CACHE_HOME: options.modelCacheRoot
    }
  });
  return parseOcrOutput(stdout);
}

async function recognizePdf(options) {
  const pdfPath = path.resolve(options.pdfPath);
  const key = await cacheKey(pdfPath);
  const cachePath = path.join(options.cacheRoot, `${key}.json`);
  try {
    return JSON.parse(await fsp.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const result = await runPaddleOcr(pdfPath, options);
      const payload = { ...result, cacheKey: key, generatedAt: new Date().toISOString() };
      await fsp.mkdir(options.cacheRoot, { recursive: true });
      await fsp.writeFile(cachePath, `${JSON.stringify(payload)}\n`, "utf8");
      return payload;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

module.exports = { cacheKey, parseOcrOutput, recognizePdf };
