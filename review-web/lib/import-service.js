const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");

const {
  classifyReviewConflict,
  clean,
  detectResultColumns,
  isConfidentNameMatch,
  normalizeStudentName
} = require("./review-data");

function localeSort(values) {
  return values.sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

async function listFilesRecursive(rootPath, extension, options = {}) {
  const files = [];
  const skipNames = new Set(options.skipDirectoryNames || []);
  const skipPaths = (options.skipPaths || []).map((item) => path.resolve(item));
  const isSkippedPath = (targetPath) => skipPaths.some((skipPath) => {
    const relative = path.relative(skipPath, targetPath);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (skipNames.has(entry.name) || isSkippedPath(fullPath)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && fullPath.toLowerCase().endsWith(extension)) {
        files.push(fullPath);
      }
    }
  }
  await walk(rootPath);
  return localeSort(files);
}

function resolveUserPath(workspaceRoot, inputPath) {
  const value = String(inputPath || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value) throw new Error("请选择文件或文件夹。");
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

function cellText(cell) {
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value === "object" && cell.value.richText) {
    return cell.value.richText.map((part) => part.text).join("").trim();
  }
  if (typeof cell.value === "object" && cell.value.text) return String(cell.value.text).trim();
  return String(cell.text || cell.value || "").trim();
}

async function inspectWorkbook(excelPath, requestedResultColumn = "") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const candidates = [];

  workbook.eachSheet((sheet) => {
    const maxHeaderRow = Math.min(sheet.rowCount, 15);
    for (let rowNumber = 1; rowNumber <= maxHeaderRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const headers = [];
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        headers.push(cellText(row.getCell(column)));
      }
      const nameIndex = headers.findIndex((header) => clean(header) === "姓名");
      if (nameIndex < 0) continue;

      const resultDetection = detectResultColumns(headers);
      const requestedIndex = requestedResultColumn
        ? headers.findIndex((header) => clean(header) === clean(requestedResultColumn))
        : -1;
      const resultIndex = requestedIndex >= 0 ? requestedIndex : resultDetection.selected?.index ?? -1;
      const rows = [];
      for (let current = rowNumber + 1; current <= sheet.rowCount; current += 1) {
        const currentRow = sheet.getRow(current);
        const name = clean(cellText(currentRow.getCell(nameIndex + 1)));
        if (!name || name === "姓名") continue;
        rows.push({
          rowNumber: current,
          name,
          result: resultIndex >= 0 ? cellText(currentRow.getCell(resultIndex + 1)) : ""
        });
      }
      candidates.push({
        sheet: sheet.name,
        headerRow: rowNumber,
        headers,
        nameColumn: nameIndex,
        resultColumn: resultIndex,
        resultHeader: resultIndex >= 0 ? headers[resultIndex] : "",
        resultDetection,
        rows
      });
    }
  });

  candidates.sort((left, right) => right.rows.length - left.rows.length);
  if (!candidates.length) throw new Error("未在所选 Excel 中找到“姓名”列。");
  return candidates[0];
}

function uniqueNameMatch(name, candidates) {
  if (candidates.includes(name)) return { name, kind: "exact" };
  const fuzzy = candidates.filter((candidate) => isConfidentNameMatch(name, candidate));
  if (fuzzy.length === 1) return { name: fuzzy[0], kind: "fuzzy" };
  if (fuzzy.length > 1) return { name: null, kind: "ambiguous", candidates: fuzzy };
  return { name: null, kind: "missing", candidates: [] };
}

function duplicateNames(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

async function analyzeImport(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const reviewRoot = path.resolve(options.reviewRoot);
  const school = String(options.school || "").trim();
  if (!school) throw new Error("无法识别学校名称，请确认后再继续。");
  const pdfDir = resolveUserPath(workspaceRoot, options.pdfDir);
  const excelPath = resolveUserPath(workspaceRoot, options.excelPath);

  const pdfStats = await fsp.stat(pdfDir).catch(() => null);
  if (!pdfStats?.isDirectory()) throw new Error("所选团员资料文件夹不存在。");
  const excelStats = await fsp.stat(excelPath).catch(() => null);
  if (!excelStats?.isFile()) throw new Error("所选 Excel 文件不存在。");

  const pdfFiles = await listFilesRecursive(pdfDir, ".pdf");
  if (!pdfFiles.length) throw new Error("所选资料文件夹中没有 PDF 文件。");
  const roster = await inspectWorkbook(excelPath, options.resultColumn || "");
  const pdfEntries = pdfFiles
    .map((pdfPath) => ({ pdfPath, name: normalizeStudentName(pdfPath, school) }))
    .filter((entry) => entry.name);
  const pdfNames = pdfEntries.map((entry) => entry.name);
  const excelNames = roster.rows.map((row) => row.name);
  const schoolReviewDir = path.join(reviewRoot, school);

  const usedExcelNames = new Set();
  const items = [];
  for (const entry of pdfEntries) {
    const match = uniqueNameMatch(entry.name, excelNames);
    const excelRow = match.name ? roster.rows.find((row) => row.name === match.name) : null;
    if (excelRow) usedExcelNames.add(excelRow.name);
    const reviewPath = path.join(schoolReviewDir, `${entry.name}_审核结果.txt`);
    const txtExists = fs.existsSync(reviewPath);
    const txtContent = txtExists ? await fsp.readFile(reviewPath, "utf8") : "";
    const conflict = classifyReviewConflict(excelRow?.result || "", txtExists, txtContent);
    items.push({
      name: entry.name,
      pdfPath: entry.pdfPath,
      excelName: excelRow?.name || "",
      matchKind: match.kind,
      matchCandidates: match.candidates || [],
      excelResult: excelRow?.result || "",
      reviewPath,
      txtExists,
      txtContent,
      conflict
    });
  }

  const onlyExcel = excelNames.filter((name) => !usedExcelNames.has(name));
  const onlyPdf = items.filter((item) => !item.excelName).map((item) => item.name);
  const fuzzyMatches = items
    .filter((item) => item.matchKind === "fuzzy")
    .map((item) => ({ excelName: item.excelName, pdfName: item.name }));
  const resultColumnChoices = roster.resultDetection.candidates.map((candidate) => candidate.header);

  return {
    workspaceRoot,
    reviewRoot,
    school,
    pdfDir,
    excelPath,
    resultColumn: roster.resultHeader,
    resultColumnChoices,
    needsResultColumn: roster.resultDetection.ambiguous && !options.resultColumn,
    roster: {
      sheet: roster.sheet,
      headerRow: roster.headerRow,
      count: roster.rows.length
    },
    items,
    onlyExcel,
    onlyPdf,
    fuzzyMatches,
    duplicates: {
      excel: duplicateNames(excelNames),
      pdf: duplicateNames(pdfNames)
    },
    summary: {
      pdfCount: pdfEntries.length,
      rosterCount: roster.rows.length,
      matchedCount: items.filter((item) => item.excelName).length,
      historyCount: items.filter((item) => item.excelResult && clean(item.excelResult) !== "无资料").length,
      conflictCount: items.filter((item) => item.conflict.requiresDecision).length,
      onlyExcelCount: onlyExcel.length,
      onlyPdfCount: onlyPdf.length
    }
  };
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function commitImport({ analysis, resolutions = {} }) {
  if (analysis.needsResultColumn) throw new Error("请先选择要读取的审核结果列。");
  if (analysis.duplicates.excel.length || analysis.duplicates.pdf.length) {
    throw new Error("名单或资料中存在重复姓名，请修正后重新检查。");
  }
  const schoolReviewDir = path.join(analysis.reviewRoot, analysis.school);
  await fsp.mkdir(schoolReviewDir, { recursive: true });
  let created = 0;
  let updated = 0;
  let kept = 0;
  let backedUp = 0;
  let backupDir = "";

  async function backupExisting(item) {
    if (!backupDir) {
      backupDir = path.join(path.dirname(analysis.reviewRoot), "审核结果历史", analysis.school, safeTimestamp());
      await fsp.mkdir(backupDir, { recursive: true });
    }
    await fsp.writeFile(path.join(backupDir, path.basename(item.reviewPath)), item.txtContent, "utf8");
    backedUp += 1;
  }

  for (const item of analysis.items) {
    let nextContent = null;
    const action = item.conflict.action;
    if (action === "create_from_excel" || action === "fill_empty") {
      nextContent = item.conflict.excel;
    } else if (action === "conflict") {
      const resolution = resolutions[item.name] || "keep_txt";
      if (resolution === "use_excel") {
        nextContent = item.conflict.excel;
      } else if (resolution === "merge") {
        nextContent = `${item.conflict.txt}；${item.conflict.excel}`;
      }
    }

    if (!item.txtExists) {
      await fsp.writeFile(item.reviewPath, nextContent ?? "", "utf8");
      created += 1;
      continue;
    }
    if (nextContent !== null && nextContent !== item.txtContent) {
      if (item.txtContent.trim()) await backupExisting(item);
      await fsp.writeFile(item.reviewPath, nextContent, "utf8");
      updated += 1;
    } else {
      kept += 1;
    }
  }

  return { created, updated, kept, backedUp, backupDir };
}

module.exports = {
  analyzeImport,
  commitImport,
  inspectWorkbook,
  listFilesRecursive,
  resolveUserPath,
  uniqueNameMatch
};
