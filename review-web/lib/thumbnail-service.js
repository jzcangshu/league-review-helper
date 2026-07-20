const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const inflight = new Map();

function pythonRuntimeCandidates(options, env = process.env) {
  const packagedPython = String(env.REVIEW_OCR_RUNTIME_PYTHON || "").trim();
  return [
    ...(packagedPython ? [path.resolve(packagedPython)] : []),
    path.join(options.runtimeRoot, "Scripts", "python.exe")
  ];
}

async function thumbnailCacheKey(pdfPath) {
  const stats = await fsp.stat(pdfPath);
  return crypto.createHash("sha1")
    .update(`${path.resolve(pdfPath)}\n${stats.size}\n${stats.mtimeMs}\nthumbnail-v1-168x224`)
    .digest("hex");
}

function normalizeManifest(value, cacheDir) {
  if (!Array.isArray(value?.pages) || !value.pages.length) throw new Error("缩略图生成结果为空。");
  const pages = value.pages.map((page, index) => {
    const pageNumber = Number(page.page);
    const fileName = String(page.fileName || "");
    if (pageNumber !== index + 1 || !/^\d+\.png$/.test(fileName)) throw new Error("缩略图生成结果不完整。");
    return {
      page: pageNumber,
      width: Number(page.width) || 1,
      height: Number(page.height) || 1,
      fileName,
      filePath: path.join(cacheDir, fileName)
    };
  });
  return { pages };
}

async function readCachedManifest(manifestPath, cacheDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const manifest = normalizeManifest(parsed, cacheDir);
    await Promise.all(manifest.pages.map((page) => fsp.access(page.filePath)));
    return manifest;
  } catch {
    return null;
  }
}

async function runRenderer(options, cacheDir) {
  let pythonPath = null;
  for (const candidate of pythonRuntimeCandidates(options)) {
    try {
      await fsp.access(candidate);
      pythonPath = candidate;
      break;
    } catch {}
  }
  if (!pythonPath) {
    const error = new Error("本地缩略图运行环境尚未准备完成。");
    error.code = "THUMBNAIL_RUNTIME_UNAVAILABLE";
    throw error;
  }
  const { stdout } = await execFileAsync(pythonPath, [
    "-X", "utf8",
    options.scriptPath,
    "--pdf", options.pdfPath,
    "--output-dir", cacheDir,
    "--max-width", "168",
    "--max-height", "224"
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1" }
  });
  return JSON.parse(String(stdout || "").replace(/^\uFEFF/, "").trim());
}

async function generatePdfThumbnails(options) {
  const pdfPath = path.resolve(options.pdfPath);
  const key = await thumbnailCacheKey(pdfPath);
  const cacheDir = path.join(options.cacheRoot, key);
  const manifestPath = path.join(cacheDir, "manifest.json");
  const cached = await readCachedManifest(manifestPath, cacheDir);
  if (cached) return { key, ...cached, cached: true };

  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      await fsp.mkdir(cacheDir, { recursive: true });
      const rendered = options.renderer
        ? await options.renderer({ ...options, pdfPath, cacheDir })
        : await runRenderer({ ...options, pdfPath }, cacheDir);
      const manifest = normalizeManifest(rendered, cacheDir);
      await fsp.writeFile(manifestPath, `${JSON.stringify({ pages: manifest.pages.map(({ filePath, ...page }) => page) })}\n`, "utf8");
      return { key, ...manifest, cached: false };
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

module.exports = { generatePdfThumbnails, normalizeManifest, pythonRuntimeCandidates, thumbnailCacheKey };
