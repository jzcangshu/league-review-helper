const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");

const { analyzeImport, commitImport, listFilesRecursive } = require("./lib/import-service");
const { writeSchoolResultsToExcel } = require("./lib/export-service");
const { recognizePdf } = require("./lib/ocr-service");
const { isExplicitlyReviewed, loadReviewStatus, setReviewed } = require("./lib/review-status");
const {
  isSchoolActive,
  migrateSource,
  scoreStudentPdfMatch,
  stableSourceId,
  updateSourceState
} = require("./lib/review-data");

const execFileAsync = promisify(execFile);
const appRoot = __dirname;
const workspaceRoot = path.resolve(appRoot, "..");
const reviewRoot = path.join(workspaceRoot, "审核结果");
const reviewHistoryRoot = path.join(workspaceRoot, "审核结果历史");
const notesHistoryRoot = path.join(workspaceRoot, "注意事项历史");
const notesPath = path.join(workspaceRoot, "注意事项.txt");
const publicRoot = path.join(appRoot, "public");
const sourcesTemplatePath = path.join(appRoot, "sources.json");
const sourcesLocalPath = path.join(appRoot, "sources.local.json");
const pdfJsRoot = path.join(appRoot, "node_modules", "pdfjs-dist", "build");
const ocrCacheRoot = path.join(appRoot, ".ocr-cache");
const ocrRuntimeRoot = path.join(appRoot, ".ocr-python");
const ocrModelCacheRoot = path.join(appRoot, ".ocr-models");
const ocrScriptPath = path.join(appRoot, "scripts", "ocr-pdf-v6.py");
const host = "127.0.0.1";
const preferredPort = 4173;
const portFilePath = path.join(os.tmpdir(), "review-web-port.json");
const fallbackPortFilePath = path.join(appRoot, "review-web-port.txt");

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

function writePortFile(port) {
  const payload = `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`;
  for (const targetPath of [portFilePath, fallbackPortFilePath]) {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, payload, "utf8");
    } catch {}
  }
}

function isInsideOrEqual(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function localeSort(values) {
  return values.sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

function toStoredPath(targetPath) {
  const resolved = path.resolve(targetPath);
  return isInsideOrEqual(workspaceRoot, resolved) ? path.relative(workspaceRoot, resolved) : resolved;
}

function resolveStoredPath(inputPath) {
  const value = String(inputPath || "").trim();
  if (!value) throw new Error("资料位置为空，请重新选择。");
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

async function readSourceFile(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.map(migrateSource).filter((source) => source.school) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function mergeSources(baseSources, localSources) {
  const merged = new Map();
  for (const source of [...baseSources, ...localSources]) {
    const migrated = migrateSource(source);
    const key = migrated.id || stableSourceId(migrated.school, migrated.folderPath);
    const duplicateKey = [...merged.entries()].find(([, existing]) =>
      existing.school === migrated.school ||
      String(existing.folderPath).toLowerCase() === String(migrated.folderPath).toLowerCase()
    )?.[0];
    if (duplicateKey) merged.delete(duplicateKey);
    merged.set(key, migrated);
  }
  return [...merged.values()];
}

async function loadSources() {
  return mergeSources(await readSourceFile(sourcesTemplatePath), await readSourceFile(sourcesLocalPath));
}

async function saveSources(sources) {
  const normalized = sources.map(migrateSource).map((source) => ({
    ...source,
    folderRelativePath: source.folderPath
  }));
  await fsp.writeFile(sourcesLocalPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function upsertSource(nextSource) {
  const sources = await loadSources();
  const migrated = migrateSource(nextSource);
  const next = sources.filter((source) =>
    source.id !== migrated.id &&
    source.school !== migrated.school &&
    String(source.folderPath).toLowerCase() !== String(migrated.folderPath).toLowerCase()
  );
  next.push(migrated);
  await saveSources(next);
  return migrated;
}

function publicSource(source) {
  const migrated = migrateSource(source);
  const resolvedFolder = migrated.folderPath ? resolveStoredPath(migrated.folderPath) : "";
  const resolvedExcel = migrated.excelPath ? resolveStoredPath(migrated.excelPath) : "";
  return {
    ...migrated,
    folderExists: Boolean(resolvedFolder && fs.existsSync(resolvedFolder)),
    excelExists: Boolean(resolvedExcel && fs.existsSync(resolvedExcel))
  };
}

async function discoverSourceFolders() {
  const sources = await loadSources();
  const known = new Set(sources.map((source) => path.resolve(resolveStoredPath(source.folderPath)).toLowerCase()));
  const candidates = [];

  async function walk(currentPath) {
    if (
      isInsideOrEqual(reviewRoot, currentPath) ||
      isInsideOrEqual(reviewHistoryRoot, currentPath) ||
      isInsideOrEqual(appRoot, currentPath) ||
      [".git", ".codex", ".agents", "node_modules", "open-source"].includes(path.basename(currentPath))
    ) return;
    const entries = await fsp.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const pdfCount = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")).length;
    if (pdfCount) {
      const relativePath = path.relative(workspaceRoot, currentPath);
      candidates.push({
        folderPath: relativePath,
        suggestedSchool: suggestSchool(currentPath),
        pdfCount,
        imported: known.has(path.resolve(currentPath).toLowerCase())
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") await walk(path.join(currentPath, entry.name));
    }
  }

  await walk(workspaceRoot);
  return candidates.sort((left, right) =>
    left.folderPath.localeCompare(right.folderPath, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

function addPdf(pdfBySchool, seen, school, pdfPath) {
  const key = `${school}\n${path.resolve(pdfPath).toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (!pdfBySchool.has(school)) pdfBySchool.set(school, []);
  pdfBySchool.get(school).push(pdfPath);
}

async function buildPdfMap(sources) {
  const pdfBySchool = new Map();
  const seen = new Set();
  const importedRoots = [];
  for (const source of sources.filter((entry) => entry.active && entry.folderPath)) {
    const folderPath = resolveStoredPath(source.folderPath);
    const stats = await fsp.stat(folderPath).catch(() => null);
    if (!stats?.isDirectory()) continue;
    importedRoots.push(folderPath);
    for (const pdfPath of await listFilesRecursive(folderPath, ".pdf")) {
      addPdf(pdfBySchool, seen, source.school, pdfPath);
    }
  }

  const workspacePdfs = await listFilesRecursive(workspaceRoot, ".pdf", {
    skipDirectoryNames: ["node_modules", ".git", ".codex", ".agents", "open-source"],
    skipPaths: [reviewRoot, reviewHistoryRoot, appRoot]
  });
  for (const pdfPath of workspacePdfs) {
    if (
      isInsideOrEqual(reviewRoot, pdfPath) ||
      isInsideOrEqual(reviewHistoryRoot, pdfPath) ||
      isInsideOrEqual(appRoot, pdfPath) ||
      importedRoots.some((root) => isInsideOrEqual(root, pdfPath))
    ) continue;
    const school = path.relative(workspaceRoot, pdfPath).split(path.sep)[0];
    if (isSchoolActive(school, sources)) addPdf(pdfBySchool, seen, school, pdfPath);
  }
  return pdfBySchool;
}

async function loadNotes() {
  const raw = await fsp.readFile(notesPath, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0]?.includes("第一条我删了")) lines.shift();
  return lines;
}

async function saveNotes(lines) {
  const normalized = Array.isArray(lines) ? lines.map((line) => String(line).trim()).filter(Boolean) : [];
  if (!normalized.length) throw new Error("审核注意事项不能为空。");
  const previous = await fsp.readFile(notesPath, "utf8").catch(() => "");
  if (previous) {
    await fsp.mkdir(notesHistoryRoot, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    await fsp.writeFile(path.join(notesHistoryRoot, name), previous, "utf8");
  }
  await fsp.writeFile(notesPath, `${normalized.join("\n")}\n`, "utf8");
  return normalized;
}

async function buildDataset() {
  const sources = await loadSources();
  const pdfBySchool = await buildPdfMap(sources);
  const reviewFiles = fs.existsSync(reviewRoot) ? await listFilesRecursive(reviewRoot, ".txt") : [];
  const items = [];
  const statuses = new Map();

  for (const reviewPath of localeSort(reviewFiles)) {
    const relativeReview = path.relative(reviewRoot, reviewPath);
    const school = relativeReview.split(path.sep)[0];
    if (!isSchoolActive(school, sources)) continue;
    const studentName = path.basename(reviewPath, "_审核结果.txt");
    const scoredCandidates = (pdfBySchool.get(school) || [])
      .map((candidate) => ({ candidate, score: scoreStudentPdfMatch(studentName, candidate, school) }))
      .filter((entry) => entry.score > 0);
    const bestScore = Math.max(0, ...scoredCandidates.map((entry) => entry.score));
    const bestCandidates = scoredCandidates.filter((entry) => entry.score === bestScore);
    const bestPdfPath = bestCandidates.length === 1 ? bestCandidates[0].candidate : "";
    const content = await fsp.readFile(reviewPath, "utf8").catch(() => "");
    if (!statuses.has(school)) statuses.set(school, await loadReviewStatus(path.join(reviewRoot, school)));
    const reviewed = Boolean(content.trim()) || isExplicitlyReviewed(statuses.get(school), studentName);
    items.push({ school, studentName, reviewPath, pdfPath: bestPdfPath, matchScore: bestScore, reviewed });
  }

  items.sort((left, right) => {
    const keyLeft = `${left.school}/${left.studentName}`;
    const keyRight = `${right.school}/${right.studentName}`;
    return keyLeft.localeCompare(keyRight, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
  items.forEach((item, index) => {
    item.id = String(index + 1);
    item.sequence = index + 1;
  });

  const schoolStats = {};
  for (const item of items) {
    schoolStats[item.school] ||= { total: 0, reviewed: 0, pending: 0, missingPdf: 0 };
    schoolStats[item.school].total += 1;
    schoolStats[item.school][item.reviewed ? "reviewed" : "pending"] += 1;
    if (!item.pdfPath) schoolStats[item.school].missingPdf += 1;
  }
  return { generatedAt: new Date().toISOString(), items, notes: await loadNotes(), schoolStats, sources };
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function serveFile(res, filePath, disposition = "inline") {
  try {
    const stats = await fsp.stat(filePath);
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": stats.size,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function runPowerShellPicker(kind) {
  const isFolder = kind === "folder";
  const owner = `$owner=New-Object System.Windows.Forms.Form; $owner.TopMost=$true; $owner.ShowInTaskbar=$false; $owner.StartPosition='CenterScreen'; $owner.Opacity=0; $owner.Show();`;
  const script = isFolder
    ? `Add-Type -AssemblyName System.Windows.Forms; ${owner} $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择团员 PDF 资料所在文件夹'; $result=$d.ShowDialog($owner); $owner.Close(); if($result -eq [System.Windows.Forms.DialogResult]::OK){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath}`
    : `Add-Type -AssemblyName System.Windows.Forms; ${owner} $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择团员名单 Excel'; $d.Filter='Excel 文件 (*.xlsx;*.xlsm)|*.xlsx;*.xlsm'; $result=$d.ShowDialog($owner); $owner.Close(); if($result -eq [System.Windows.Forms.DialogResult]::OK){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.FileName}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], {
    windowsHide: false,
    encoding: "utf8",
    timeout: 120000
  }).then(({ stdout }) => stdout.trim()).catch((error) => {
    const detail = String(error?.stderr || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(detail ? `系统选择窗口打开失败：${detail}` : "系统选择窗口打开失败，请重新启动审核工具后再试。");
  });
}

function suggestSchool(pdfDir) {
  return path.basename(pdfDir);
}

async function start() {
  await fsp.mkdir(reviewRoot, { recursive: true });
  let dataset = await buildDataset();
  const importAnalyses = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${host}:${preferredPort}`);
      const pathname = requestUrl.pathname;

      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true, generatedAt: dataset.generatedAt, workspaceRoot });
        return;
      }
      if (req.method === "GET" && pathname === "/api/bootstrap") {
        sendJson(res, 200, {
          generatedAt: dataset.generatedAt,
          notes: dataset.notes,
          schoolStats: dataset.schoolStats,
          items: dataset.items.map((item) => ({
            id: item.id,
            sequence: item.sequence,
            school: item.school,
            studentName: item.studentName,
            hasPdf: Boolean(item.pdfPath),
            reviewed: item.reviewed,
            matchQuality: item.matchScore === 100 ? "准确" : item.pdfPath ? "需核对" : "未找到"
          }))
        });
        return;
      }
      if (req.method === "GET" && pathname === "/api/sources") {
        sendJson(res, 200, {
          sources: (await loadSources()).map(publicSource)
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/picker/folder") {
        const selectedPath = await runPowerShellPicker("folder");
        sendJson(res, 200, {
          path: selectedPath,
          suggestedSchool: selectedPath ? suggestSchool(selectedPath) : ""
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/picker/excel") {
        sendJson(res, 200, { path: await runPowerShellPicker("excel") });
        return;
      }
      if (req.method === "POST" && pathname === "/api/import/analyze") {
        const body = await readRequestBody(req);
        const pdfDir = resolveStoredPath(body.pdfDir);
        const analysis = await analyzeImport({
          workspaceRoot,
          reviewRoot,
          school: String(body.school || "").trim() || suggestSchool(pdfDir),
          pdfDir,
          excelPath: resolveStoredPath(body.excelPath),
          resultColumn: body.resultColumn || ""
        });
        const analysisId = crypto.randomUUID();
        importAnalyses.set(analysisId, analysis);
        while (importAnalyses.size > 20) importAnalyses.delete(importAnalyses.keys().next().value);
        sendJson(res, 200, {
          ...analysis,
          analysisId,
          workspaceRoot: undefined,
          reviewRoot: undefined,
          rosterRows: undefined,
          historyPreview: analysis.rosterRows.map((row) => ({ name: row.name, problem: row.result })),
          items: analysis.items.map((item) => ({
            pdfIndex: item.pdfIndex,
            name: item.name,
            excelName: item.excelName,
            matchKind: item.matchKind,
            matchCandidates: item.matchCandidates,
            excelResult: item.excelResult,
            txtContent: item.txtContent,
            conflict: item.conflict,
            pdfPreviewUrl: `/api/import/analysis/${encodeURIComponent(analysisId)}/pdf/${item.pdfIndex}`
          }))
        });
        return;
      }
      const importPdfMatch = pathname.match(/^\/api\/import\/analysis\/([^/]+)\/pdf\/(\d+)$/);
      if (req.method === "GET" && importPdfMatch) {
        const analysis = importAnalyses.get(decodeURIComponent(importPdfMatch[1]));
        const item = analysis?.items.find((entry) => entry.pdfIndex === Number(importPdfMatch[2]));
        if (!item?.pdfPath) return sendJson(res, 404, { error: "这份待核对 PDF 已失效，请重新检查资料。" });
        await serveFile(res, item.pdfPath);
        return;
      }
      if (req.method === "POST" && pathname === "/api/import/commit") {
        const body = await readRequestBody(req);
        const pdfDir = resolveStoredPath(body.pdfDir);
        const excelPath = resolveStoredPath(body.excelPath);
        const school = String(body.school || "").trim() || suggestSchool(pdfDir);
        const analysis = importAnalyses.get(body.analysisId) || await analyzeImport({
            workspaceRoot,
            reviewRoot,
            school,
            pdfDir,
            excelPath,
            resultColumn: body.resultColumn || ""
          });
        const result = await commitImport({
          analysis,
          bindings: body.bindings || {},
          resolutions: body.resolutions || {}
        });
        const now = new Date().toISOString();
        const source = await upsertSource({
          id: body.sourceId || stableSourceId(school, toStoredPath(pdfDir)),
          school,
          folderPath: toStoredPath(pdfDir),
          excelPath: toStoredPath(excelPath),
          active: true,
          createdAt: now,
          updatedAt: now
        });
        dataset = await buildDataset();
        if (body.analysisId) importAnalyses.delete(body.analysisId);
        sendJson(res, 200, { ok: true, source: publicSource(source), ...result, summary: analysis.summary });
        return;
      }
      if (req.method === "POST" && pathname === "/api/export/excel") {
        const body = await readRequestBody(req);
        const school = String(body.school || "").trim();
        const schoolItems = dataset.items.filter((item) => item.school === school);
        if (!school || !schoolItems.length) return sendJson(res, 400, { error: "请选择要回填的学校。" });
        const sources = await loadSources();
        const source = sources.find((item) => item.school === school && item.active);
        const storedExcelPath = String(body.excelPath || source?.excelPath || "").trim();
        if (!storedExcelPath) return sendJson(res, 200, { needsExcelPath: true });
        const excelPath = resolveStoredPath(storedExcelPath);
        const result = await writeSchoolResultsToExcel({
          workspaceRoot,
          school,
          excelPath,
          items: schoolItems,
          resultColumn: body.resultColumn || ""
        });
        if (!result.needsResultColumn && source && source.excelPath !== toStoredPath(excelPath)) {
          await upsertSource({ ...source, excelPath: toStoredPath(excelPath), updatedAt: new Date().toISOString() });
        }
        sendJson(res, 200, result);
        return;
      }
      const sourceStateMatch = pathname.match(/^\/api\/sources\/([^/]+)\/(remove|restore)$/);
      if (req.method === "POST" && sourceStateMatch) {
        const sourceId = decodeURIComponent(sourceStateMatch[1]);
        const active = sourceStateMatch[2] === "restore";
        const sources = updateSourceState(await loadSources(), sourceId, active);
        await saveSources(sources);
        dataset = await buildDataset();
        sendJson(res, 200, { ok: true, sources: sources.map(publicSource) });
        return;
      }
      if (req.method === "GET" && pathname === "/api/notes") {
        sendJson(res, 200, { notes: await loadNotes() });
        return;
      }
      if (req.method === "PUT" && pathname === "/api/notes") {
        const body = await readRequestBody(req);
        dataset.notes = await saveNotes(body.notes);
        sendJson(res, 200, { ok: true, notes: dataset.notes });
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/api/review/")) {
        const item = dataset.items.find((entry) => entry.id === pathname.slice("/api/review/".length));
        if (!item) return sendJson(res, 404, { error: "未找到这份审核记录。" });
        sendJson(res, 200, {
          id: item.id,
          content: await fsp.readFile(item.reviewPath, "utf8").catch(() => ""),
          reviewed: item.reviewed
        });
        return;
      }
      if (req.method === "PUT" && pathname.startsWith("/api/review/")) {
        const item = dataset.items.find((entry) => entry.id === pathname.slice("/api/review/".length));
        if (!item) return sendJson(res, 404, { error: "未找到这份审核记录。" });
        const body = await readRequestBody(req);
        const content = typeof body.content === "string" ? body.content : "";
        const reviewed = body.reviewed !== false;
        if (!reviewed && content.trim()) return sendJson(res, 400, { error: "有审核意见时不能标记为未审核。" });
        await fsp.writeFile(item.reviewPath, content, "utf8");
        await setReviewed(path.dirname(item.reviewPath), item.studentName, reviewed);
        item.reviewed = reviewed || Boolean(content.trim());
        sendJson(res, 200, { ok: true, reviewed: item.reviewed, savedAt: new Date().toISOString() });
        return;
      }
      const pdfMatch = pathname.match(/^\/api\/pdf\/([^/]+)(\/download)?$/);
      if (req.method === "GET" && pdfMatch) {
        const item = dataset.items.find((entry) => entry.id === decodeURIComponent(pdfMatch[1]));
        if (!item?.pdfPath) return sendJson(res, 404, { error: "没有找到对应的 PDF 资料。" });
        await serveFile(res, item.pdfPath, pdfMatch[2] ? "attachment" : "inline");
        return;
      }
      const ocrMatch = pathname.match(/^\/api\/ocr\/([^/]+)$/);
      if (req.method === "GET" && ocrMatch) {
        const item = dataset.items.find((entry) => entry.id === decodeURIComponent(ocrMatch[1]));
        if (!item?.pdfPath) return sendJson(res, 404, { error: "没有找到对应的 PDF 资料。" });
        const result = await recognizePdf({
          pdfPath: item.pdfPath,
          cacheRoot: ocrCacheRoot,
          scriptPath: ocrScriptPath,
          runtimeRoot: ocrRuntimeRoot,
          modelCacheRoot: ocrModelCacheRoot
        });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "GET" && pathname === "/vendor/pdf.mjs") {
        await serveFile(res, path.join(pdfJsRoot, "pdf.min.mjs"));
        return;
      }
      if (req.method === "GET" && pathname === "/vendor/pdf.worker.mjs") {
        await serveFile(res, path.join(pdfJsRoot, "pdf.worker.min.mjs"));
        return;
      }

      const staticPath = pathname === "/"
        ? path.join(publicRoot, "index.html")
        : path.join(publicRoot, pathname.replace(/^\/+/, ""));
      if (isInsideOrEqual(publicRoot, staticPath) && fs.existsSync(staticPath)) {
        await serveFile(res, staticPath);
        return;
      }
      sendText(res, 404, "Not found");
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.once("listening", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : preferredPort;
    writePortFile(port);
    console.log(`审核工具已启动：http://${host}:${port}`);
    console.log(`共加载 ${dataset.items.length} 份审核结果。`);
  });

  function tryListen(port) {
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" && port < preferredPort + 20) return tryListen(port + 1);
      throw error;
    });
    server.listen(port, host);
  }
  tryListen(preferredPort);
}

start().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
