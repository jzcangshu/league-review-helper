const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const inflight = new Map();

function parseOcrOutput(stdout) {
  const value = String(stdout || "").replace(/^\uFEFF/, "").trim();
  if (!value) throw new Error("OCR 没有返回识别结果。");
  return JSON.parse(value);
}

async function cacheKey(pdfPath) {
  const stats = await fsp.stat(pdfPath);
  return crypto.createHash("sha1")
    .update(`${path.resolve(pdfPath)}\n${stats.size}\n${stats.mtimeMs}\nocr-v2`)
    .digest("hex");
}

async function runWindowsOcr(pdfPath, scriptPath) {
  if (process.platform !== "win32") throw new Error("实验性 OCR 当前仅支持 Windows 11。");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-PdfPath", pdfPath
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024
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
      const result = await runWindowsOcr(pdfPath, options.scriptPath);
      const payload = { ...result, cacheKey: key, generatedAt: new Date().toISOString() };
      await fsp.mkdir(options.cacheRoot, { recursive: true });
      await fsp.writeFile(cachePath, `${JSON.stringify(payload)}\n`, "utf8");
      return payload;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

module.exports = { cacheKey, parseOcrOutput, recognizePdf };
