const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const appRoot = __dirname;
const workspaceRoot = path.resolve(appRoot, "..");
const reviewRoot = path.join(workspaceRoot, "审核结果");
const notesPath = path.join(workspaceRoot, "注意事项.txt");
const publicRoot = path.join(appRoot, "public");
const sourcesPath = path.join(appRoot, "sources.json");
const host = "127.0.0.1";
const preferredPort = 4173;
const portFilePath = path.join(os.tmpdir(), "review-web-port.json");
const fallbackPortFilePath = path.join(appRoot, "review-web-port.txt");

fs.mkdirSync(path.dirname(portFilePath), { recursive: true });

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function writePortFile(port) {
  const payload = `${JSON.stringify({
    port,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2)}\n`;

  for (const targetPath of [portFilePath, fallbackPortFilePath]) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, payload, "utf8");
      return targetPath;
    } catch {}
  }
  return null;
}

function ensureInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideOrEqual(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function listFilesRecursive(rootPath, extension) {
  const files = [];

  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.toLowerCase().endsWith(extension)) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootPath);
  return files;
}

function localeSort(values) {
  return values.sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

function stripExtension(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function normalizeStudentName(input, school = "") {
  const chineseOnly = (input.match(/[\u4e00-\u9fa5]+/g) || []).join("");
  const withoutSchool = school ? chineseOnly.replaceAll(school, "") : chineseOnly;
  return withoutSchool
    .replace(/入团志愿书|入团申请书|入团申请|审核结果|团员资料|转PDF/g, "")
    .replace(/班/g, "")
    .trim();
}

function buildShortName(filePath, school = "") {
  const baseName = stripExtension(filePath);
  return normalizeStudentName(baseName, school);
}

function scoreCandidate(studentName, pdfPath, school = "") {
  const pdfName = buildShortName(pdfPath, school);
  if (!pdfName) {
    return 0;
  }
  if (pdfName === studentName) {
    return 100;
  }
  if (pdfName.includes(studentName) || studentName.includes(pdfName)) {
    return 80;
  }
  const rawBase = stripExtension(pdfPath).replace(/[\s_-]+/g, "");
  if (rawBase.includes(studentName)) {
    return 60;
  }
  return 0;
}

function getNoticeLines(rawText) {
  const rawLines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines[0] && rawLines[0].includes("第一条我删了")) {
    rawLines.shift();
  }
  return rawLines;
}

async function loadSources() {
  try {
    const raw = await fsp.readFile(sourcesPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((source) => source && typeof source.school === "string" && typeof source.folderRelativePath === "string")
      .map((source) => ({
        school: source.school.trim(),
        folderRelativePath: source.folderRelativePath.replaceAll("/", path.sep)
      }))
      .filter((source) => source.school && source.folderRelativePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveSources(sources) {
  const normalized = [];
  const seen = new Set();
  for (const source of sources) {
    const school = String(source.school || "").trim();
    const folderRelativePath = String(source.folderRelativePath || "").trim().replaceAll("/", path.sep);
    if (!school || !folderRelativePath) {
      continue;
    }
    const key = `${school}\n${folderRelativePath.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ school, folderRelativePath });
  }
  await fsp.writeFile(sourcesPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function resolveWorkspacePath(inputPath) {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath) {
    throw new Error("请填写资料文件夹路径。");
  }
  const normalizedInput = rawPath.replace(/^["']|["']$/g, "");
  const resolvedPath = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(workspaceRoot, normalizedInput);
  if (!isInsideOrEqual(workspaceRoot, resolvedPath)) {
    throw new Error("资料文件夹必须在当前工作区内。");
  }
  return resolvedPath;
}

async function ensureReviewFilesForSource(source) {
  const folderPath = resolveWorkspacePath(source.folderRelativePath);
  const stats = await fsp.stat(folderPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`资料文件夹不存在：${source.folderRelativePath}`);
  }

  const pdfFiles = localeSort(await listFilesRecursive(folderPath, ".pdf"));
  if (!pdfFiles.length) {
    throw new Error("资料文件夹里没有 PDF。");
  }

  const schoolReviewRoot = path.join(reviewRoot, source.school);
  await fsp.mkdir(schoolReviewRoot, { recursive: true });

  let created = 0;
  let existing = 0;
  for (const pdfPath of pdfFiles) {
    const studentName = buildShortName(pdfPath, source.school);
    if (!studentName) {
      continue;
    }
    const reviewPath = path.join(schoolReviewRoot, `${studentName}_审核结果.txt`);
    if (fs.existsSync(reviewPath)) {
      existing += 1;
      continue;
    }
    await fsp.writeFile(reviewPath, "", "utf8");
    created += 1;
  }

  return {
    pdfCount: pdfFiles.length,
    created,
    existing,
    reviewDirRelativePath: path.relative(workspaceRoot, schoolReviewRoot)
  };
}

function addPdfToMap(pdfBySchool, seenPdfPaths, school, pdfPath) {
  const key = path.resolve(pdfPath).toLowerCase();
  if (seenPdfPaths.has(key)) {
    return;
  }
  seenPdfPaths.add(key);
  if (!pdfBySchool.has(school)) {
    pdfBySchool.set(school, []);
  }
  pdfBySchool.get(school).push(pdfPath);
}

async function buildPdfMap(sources) {
  const pdfBySchool = new Map();
  const seenPdfPaths = new Set();
  const importedFolders = [];

  for (const source of sources) {
    const folderPath = resolveWorkspacePath(source.folderRelativePath);
    const stats = await fsp.stat(folderPath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      continue;
    }
    importedFolders.push(folderPath);
    const pdfFiles = localeSort(await listFilesRecursive(folderPath, ".pdf"));
    for (const pdfPath of pdfFiles) {
      addPdfToMap(pdfBySchool, seenPdfPaths, source.school, pdfPath);
    }
  }

  const workspacePdfFiles = localeSort(
    (await listFilesRecursive(workspaceRoot, ".pdf")).filter((filePath) => !isInsideOrEqual(reviewRoot, filePath))
  );
  for (const pdfPath of workspacePdfFiles) {
    if (importedFolders.some((folderPath) => isInsideOrEqual(folderPath, pdfPath))) {
      continue;
    }
    const relativePath = path.relative(workspaceRoot, pdfPath);
    const school = relativePath.split(path.sep)[0];
    addPdfToMap(pdfBySchool, seenPdfPaths, school, pdfPath);
  }

  return pdfBySchool;
}

async function discoverSourceFolders() {
  const sources = await loadSources();
  const imported = new Set(sources.map((source) => source.folderRelativePath.toLowerCase()));
  const candidates = [];

  async function walk(currentPath) {
    if (isInsideOrEqual(reviewRoot, currentPath) || isInsideOrEqual(appRoot, currentPath)) {
      return;
    }

    const entries = await fsp.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const pdfCount = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")).length;
    if (pdfCount > 0) {
      const relativePath = path.relative(workspaceRoot, currentPath);
      const firstSegment = relativePath.split(path.sep)[0];
      candidates.push({
        folderRelativePath: relativePath,
        suggestedSchool: firstSegment || path.basename(currentPath),
        pdfCount,
        imported: imported.has(relativePath.toLowerCase())
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      await walk(path.join(currentPath, entry.name));
    }
  }

  await walk(workspaceRoot);
  return candidates.sort((a, b) =>
    a.folderRelativePath.localeCompare(b.folderRelativePath, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

async function buildDataset() {
  const sources = await loadSources();
  const reviewFiles = localeSort(await listFilesRecursive(reviewRoot, ".txt"));
  const pdfBySchool = await buildPdfMap(sources);

  const reviewItems = [];
  const matchedPdfPaths = new Set();

  for (const reviewPath of reviewFiles) {
    const relativeReview = path.relative(reviewRoot, reviewPath);
    const school = relativeReview.split(path.sep)[0];
    const studentName = path.basename(reviewPath, "_审核结果.txt");
    const candidates = pdfBySchool.get(school) || [];

    let bestPdfPath = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = scoreCandidate(studentName, candidate, school);
      if (score > bestScore) {
        bestScore = score;
        bestPdfPath = candidate;
      }
    }

    if (bestPdfPath) {
      matchedPdfPaths.add(bestPdfPath);
    }

    reviewItems.push({
      id: String(reviewItems.length + 1),
      school,
      studentName,
      reviewPath,
      pdfPath: bestPdfPath,
      pdfRelativePath: bestPdfPath ? path.relative(workspaceRoot, bestPdfPath) : null,
      reviewRelativePath: path.relative(workspaceRoot, reviewPath),
      matchScore: bestScore
    });
  }

  const matchedItems = reviewItems
    .filter((item) => item.pdfPath)
    .sort((a, b) => a.pdfRelativePath.localeCompare(b.pdfRelativePath, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  const unmatchedItems = reviewItems
    .filter((item) => !item.pdfPath)
    .sort((a, b) => {
      const aKey = `${a.school}/${a.studentName}`;
      const bKey = `${b.school}/${b.studentName}`;
      return aKey.localeCompare(bKey, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    });

  const orderedItems = [...matchedItems, ...unmatchedItems].map((item, index) => ({
    ...item,
    sequence: index + 1,
    pdfUrl: item.pdfRelativePath
      ? `/api/file?path=${encodeURIComponent(item.pdfRelativePath)}`
      : null
  }));

  const notesRaw = await fsp.readFile(notesPath, "utf8");
  const notes = getNoticeLines(notesRaw);

  return {
    generatedAt: new Date().toISOString(),
    items: orderedItems,
    notes
  };
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function serveStaticFile(res, targetPath) {
  try {
    const fileBuffer = await fsp.readFile(targetPath);
    res.writeHead(200, {
      "Content-Type": getContentType(targetPath),
      "Cache-Control": "no-store"
    });
    res.end(fileBuffer);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  return bodyText ? JSON.parse(bodyText) : {};
}

async function start() {
  await fsp.mkdir(reviewRoot, { recursive: true });
  let dataset = await buildDataset();

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${host}:${preferredPort}`);
      const pathname = requestUrl.pathname;

      if (req.method === "GET" && pathname === "/api/bootstrap") {
        const items = dataset.items.map((item) => ({
          id: item.id,
          sequence: item.sequence,
          school: item.school,
          studentName: item.studentName,
          pdfUrl: item.pdfUrl,
          hasPdf: Boolean(item.pdfUrl),
          reviewRelativePath: item.reviewRelativePath,
          matchScore: item.matchScore
        }));
        sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          items,
          notes: dataset.notes
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/sources") {
        sendJson(res, 200, {
          sources: await loadSources(),
          candidates: await discoverSourceFolders()
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/sources/import") {
        const body = await readRequestBody(req);
        const school = String(body.school || "").trim();
        const folderPath = resolveWorkspacePath(body.folderRelativePath);
        if (!school) {
          sendJson(res, 400, { error: "请填写学校名称。" });
          return;
        }
        const source = {
          school,
          folderRelativePath: path.relative(workspaceRoot, folderPath)
        };
        const result = await ensureReviewFilesForSource(source);
        const sources = await loadSources();
        const nextSources = sources.filter(
          (entry) =>
            entry.school !== source.school &&
            entry.folderRelativePath.toLowerCase() !== source.folderRelativePath.toLowerCase()
        );
        nextSources.push(source);
        await saveSources(nextSources);
        dataset = await buildDataset();
        sendJson(res, 200, { ok: true, source, ...result });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/review/")) {
        const itemId = pathname.slice("/api/review/".length);
        const item = dataset.items.find((entry) => entry.id === itemId);
        if (!item) {
          sendJson(res, 404, { error: "未找到对应审核结果文件。" });
          return;
        }
        const content = await fsp.readFile(item.reviewPath, "utf8").catch(() => "");
        sendJson(res, 200, {
          id: item.id,
          studentName: item.studentName,
          school: item.school,
          content
        });
        return;
      }

      if (req.method === "PUT" && pathname.startsWith("/api/review/")) {
        const itemId = pathname.slice("/api/review/".length);
        const item = dataset.items.find((entry) => entry.id === itemId);
        if (!item) {
          sendJson(res, 404, { error: "未找到对应审核结果文件。" });
          return;
        }
        const body = await readRequestBody(req);
        const content = typeof body.content === "string" ? body.content : "";
        await fsp.writeFile(item.reviewPath, content, "utf8");
        sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/file") {
        const relativePath = requestUrl.searchParams.get("path") || "";
        const filePath = path.resolve(workspaceRoot, relativePath);
        if (!ensureInsideRoot(workspaceRoot, filePath)) {
          sendJson(res, 400, { error: "非法文件路径。" });
          return;
        }
        await serveStaticFile(res, filePath);
        return;
      }

      const staticPath =
        pathname === "/"
          ? path.join(publicRoot, "index.html")
          : path.join(publicRoot, pathname.replace(/^\/+/, ""));

      if (ensureInsideRoot(publicRoot, staticPath) && fs.existsSync(staticPath)) {
        await serveStaticFile(res, staticPath);
        return;
      }

      sendText(res, 404, "Not found");
    } catch (error) {
      sendJson(res, 500, {
        error: "服务处理失败。",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const onListening = () => {
    const itemCount = dataset.items.length;
    const matchedCount = dataset.items.filter((item) => item.pdfUrl).length;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : preferredPort;
    writePortFile(port);
    console.log(`审核工具已启动：http://${host}:${port}`);
    console.log(`共加载 ${itemCount} 份审核结果，匹配到 ${matchedCount} 份 PDF。`);
  };

  server.once("listening", onListening);

  const tryListen = (port) => {
    const onError = (error) => {
      if (error && error.code === "EADDRINUSE" && port < preferredPort + 20) {
        tryListen(port + 1);
        return;
      }
      throw error;
    };
    server.once("error", onError);
    server.listen(port, host);
  };

  tryListen(preferredPort);
}

start().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
