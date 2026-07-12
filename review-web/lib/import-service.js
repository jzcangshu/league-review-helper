const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { renameReviewedName } = require("./review-status");

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
  for (const [pdfIndex, entry] of pdfEntries.entries()) {
    const match = uniqueNameMatch(entry.name, excelNames);
    const excelRow = match.name ? roster.rows.find((row) => row.name === match.name) : null;
    if (excelRow) usedExcelNames.add(excelRow.name);
    const reviewPath = path.join(schoolReviewDir, `${entry.name}_审核结果.txt`);
    const txtExists = fs.existsSync(reviewPath);
    const txtContent = txtExists ? await fsp.readFile(reviewPath, "utf8") : "";
    const conflict = classifyReviewConflict(excelRow?.result || "", txtExists, txtContent);
    items.push({
      pdfIndex,
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

  const possibleTypoNames = new Set(items.flatMap((item) => item.matchCandidates || []));
  const onlyExcel = excelNames.filter((name) => !usedExcelNames.has(name) && !possibleTypoNames.has(name));
  const onlyPdf = items.filter((item) => item.matchKind === "missing").map((item) => item.name);
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
      count: roster.rows.length,
      nameColumn: roster.nameColumn,
      resultColumn: roster.resultColumn
    },
    rosterRows: roster.rows,
    rosterNames: excelNames,
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

async function commitImport({ analysis, bindings = {}, resolutions = {} }) {
  if (analysis.needsResultColumn) throw new Error("请先选择要读取的审核结果列。");
  if (analysis.duplicates.excel.length || analysis.duplicates.pdf.length) {
    throw new Error("名单或资料中存在重复姓名，请修正后重新检查。");
  }
  const { items: resolvedItems, appendNames, corrections } = resolveBindings(analysis, bindings);
  await validateNameCorrections(analysis, resolvedItems, corrections, appendNames);
  const excelUpdate = await updateRosterWorkbook(analysis, appendNames, corrections);
  const items = await applyNameCorrections(analysis, resolvedItems, corrections);
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

  for (const item of items) {
    if (item.skip) continue;
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

  return {
    created,
    updated,
    kept,
    backedUp,
    backupDir,
    appended: excelUpdate.appended,
    renamed: excelUpdate.renamed || corrections.length,
    excelBackupPath: excelUpdate.backupPath
  };
}

function resolveBindings(analysis, bindings) {
  const rosterByName = new Map(analysis.rosterRows.map((row) => [row.name, row]));
  const usedNames = new Set(analysis.items.filter((item) => item.matchKind === "exact").map((item) => item.excelName));
  const appendNames = [];
  const corrections = [];
  const items = analysis.items.map((item) => {
    if (item.matchKind === "exact") return item;
    const selected = String(bindings[item.name] || "").trim();
    if (!selected) throw new Error(`请确认“${item.name}”应绑定到哪位人员。`);
    if (selected === "__skip__") return { ...item, skip: true };
    if (selected === "__append__") {
      appendNames.push(item.name);
      return {
        ...item,
        excelName: "",
        excelResult: "",
        conflict: classifyReviewConflict("", item.txtExists, item.txtContent)
      };
    }
    const correctionMatch = selected.match(/^(excel|pdf):(.+)$/);
    const selectedName = correctionMatch ? correctionMatch[2] : selected;
    const row = rosterByName.get(selectedName);
    if (!row) throw new Error(`名单中不存在“${selectedName}”，请重新核对绑定。`);
    if (usedNames.has(selectedName)) throw new Error(`名单中的“${selectedName}”被重复绑定。`);
    const canonicalName = correctionMatch?.[1] === "pdf" ? item.name : selectedName;
    if (correctionMatch?.[1] === "pdf" && rosterByName.has(canonicalName) && canonicalName !== selectedName) {
      throw new Error(`名单中已经存在“${canonicalName}”，不能再次改名。`);
    }
    usedNames.add(selectedName);
    if (correctionMatch) {
      corrections.push({
        pdfName: item.name,
        excelName: selectedName,
        canonicalName,
        source: correctionMatch[1]
      });
    }
    return {
      ...item,
      excelName: selectedName,
      excelResult: row.result,
      conflict: classifyReviewConflict(row.result, item.txtExists, item.txtContent),
      canonicalName
    };
  });
  return { items, appendNames, corrections };
}

async function updateRosterWorkbook(analysis, names, corrections = []) {
  const excelCorrections = corrections.filter((item) => item.source === "pdf" && item.excelName !== item.canonicalName);
  if (!names.length && !excelCorrections.length) return { appended: 0, renamed: 0, backupPath: "" };
  if (path.extname(analysis.excelPath).toLowerCase() !== ".xlsx") {
    throw new Error("带宏 Excel 无法安全自动修改名单，请先另存为 .xlsx 后重新导入。");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(analysis.excelPath);
  const sheet = workbook.getWorksheet(analysis.roster.sheet);
  if (!sheet) throw new Error("无法重新打开所选名单工作表。");

  const timestamp = safeTimestamp();
  const backupDir = path.join(path.dirname(analysis.reviewRoot), "Excel历史", analysis.school, timestamp);
  await fsp.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(analysis.excelPath));
  await fsp.copyFile(analysis.excelPath, backupPath);

  let insertAt = Math.max(analysis.roster.headerRow + 1, ...analysis.rosterRows.map((row) => row.rowNumber)) + 1;
  const styleSourceRow = sheet.getRow(insertAt - 1);
  for (const name of names) {
    const row = sheet.insertRow(insertAt, []);
    row.height = styleSourceRow.height;
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      row.getCell(column).style = { ...styleSourceRow.getCell(column).style };
    }
    row.getCell(analysis.roster.nameColumn + 1).value = name;
    if (analysis.roster.resultColumn >= 0) row.getCell(analysis.roster.resultColumn + 1).value = null;
    insertAt += 1;
  }
  const rowsByName = new Map(analysis.rosterRows.map((row) => [row.name, row]));
  for (const correction of excelCorrections) {
    const rosterRow = rowsByName.get(correction.excelName);
    if (!rosterRow) throw new Error(`无法在 Excel 中定位“${correction.excelName}”。`);
    sheet.getRow(rosterRow.rowNumber).getCell(analysis.roster.nameColumn + 1).value = correction.canonicalName;
  }
  await workbook.xlsx.writeFile(analysis.excelPath);
  return { appended: names.length, renamed: excelCorrections.length, backupPath };
}

async function appendRosterRows(analysis, names) {
  return updateRosterWorkbook(analysis, names, []);
}

async function mergeOrMoveReviewFile(analysis, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return path.join(analysis.reviewRoot, analysis.school, `${newName}_审核结果.txt`);
  const reviewDir = path.join(analysis.reviewRoot, analysis.school);
  const oldPath = path.join(reviewDir, `${oldName}_审核结果.txt`);
  const newPath = path.join(reviewDir, `${newName}_审核结果.txt`);
  const oldExists = fs.existsSync(oldPath);
  const newExists = fs.existsSync(newPath);
  if (!oldExists) return newPath;
  if (!newExists) {
    await fsp.rename(oldPath, newPath);
    return newPath;
  }
  const [oldContent, newContent] = await Promise.all([
    fsp.readFile(oldPath, "utf8"),
    fsp.readFile(newPath, "utf8")
  ]);
  if (oldContent.trim() && newContent.trim() && oldContent.trim() !== newContent.trim()) {
    throw new Error(`“${oldName}”和“${newName}”均有不同审核结果，已停止自动统一姓名。`);
  }
  if (!newContent.trim() && oldContent.trim()) await fsp.writeFile(newPath, oldContent, "utf8");
  const archiveDir = path.join(path.dirname(analysis.reviewRoot), "审核结果历史", analysis.school, `姓名统一-${safeTimestamp()}`);
  await fsp.mkdir(archiveDir, { recursive: true });
  await fsp.rename(oldPath, path.join(archiveDir, path.basename(oldPath)));
  return newPath;
}

async function applyNameCorrections(analysis, items, corrections) {
  const byPdfName = new Map(corrections.map((item) => [item.pdfName, item]));
  const correctedItems = [];
  for (const item of items) {
    const correction = byPdfName.get(item.name);
    if (!correction) {
      correctedItems.push(item);
      continue;
    }
    let pdfPath = item.pdfPath;
    if (correction.source === "excel" && correction.pdfName !== correction.canonicalName) {
      const extension = path.extname(pdfPath);
      const base = path.basename(pdfPath, extension);
      const renamedBase = base.includes(correction.pdfName)
        ? base.replace(correction.pdfName, correction.canonicalName)
        : correction.canonicalName;
      const targetPdfPath = path.join(path.dirname(pdfPath), `${renamedBase}${extension}`);
      if (fs.existsSync(targetPdfPath)) throw new Error(`PDF 文件“${path.basename(targetPdfPath)}”已经存在，已停止自动改名。`);
      await fsp.rename(pdfPath, targetPdfPath);
      pdfPath = targetPdfPath;
    }
    const oldReviewName = correction.source === "excel" ? correction.pdfName : correction.excelName;
    const reviewPath = await mergeOrMoveReviewFile(analysis, oldReviewName, correction.canonicalName);
    await renameReviewedName(path.dirname(reviewPath), oldReviewName, correction.canonicalName);
    const txtExists = fs.existsSync(reviewPath);
    const txtContent = txtExists ? await fsp.readFile(reviewPath, "utf8") : "";
    correctedItems.push({
      ...item,
      name: correction.canonicalName,
      pdfPath,
      reviewPath,
      txtExists,
      txtContent,
      conflict: classifyReviewConflict(item.excelResult, txtExists, txtContent)
    });
  }
  return correctedItems;
}

async function validateNameCorrections(analysis, items, corrections, appendNames) {
  if ((appendNames.length || corrections.some((item) => item.source === "pdf")) && path.extname(analysis.excelPath).toLowerCase() !== ".xlsx") {
    throw new Error("带宏 Excel 无法安全自动修改名单，请先另存为 .xlsx 后重新导入。");
  }
  const itemsByName = new Map(items.map((item) => [item.name, item]));
  for (const correction of corrections) {
    const item = itemsByName.get(correction.pdfName);
    if (correction.source === "excel" && correction.pdfName !== correction.canonicalName) {
      const extension = path.extname(item.pdfPath);
      const base = path.basename(item.pdfPath, extension);
      const renamedBase = base.includes(correction.pdfName)
        ? base.replace(correction.pdfName, correction.canonicalName)
        : correction.canonicalName;
      const targetPdfPath = path.join(path.dirname(item.pdfPath), `${renamedBase}${extension}`);
      if (fs.existsSync(targetPdfPath)) throw new Error(`PDF 文件“${path.basename(targetPdfPath)}”已经存在，已停止自动改名。`);
    }
    const oldReviewName = correction.source === "excel" ? correction.pdfName : correction.excelName;
    if (oldReviewName === correction.canonicalName) continue;
    const reviewDir = path.join(analysis.reviewRoot, analysis.school);
    const oldPath = path.join(reviewDir, `${oldReviewName}_审核结果.txt`);
    const newPath = path.join(reviewDir, `${correction.canonicalName}_审核结果.txt`);
    if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
      const [oldContent, newContent] = await Promise.all([fsp.readFile(oldPath, "utf8"), fsp.readFile(newPath, "utf8")]);
      if (oldContent.trim() && newContent.trim() && oldContent.trim() !== newContent.trim()) {
        throw new Error(`“${oldReviewName}”和“${correction.canonicalName}”均有不同审核结果，已停止自动统一姓名。`);
      }
    }
  }
}

module.exports = {
  analyzeImport,
  appendRosterRows,
  commitImport,
  inspectWorkbook,
  listFilesRecursive,
  resolveBindings,
  resolveUserPath,
  updateRosterWorkbook,
  validateNameCorrections,
  uniqueNameMatch
};
