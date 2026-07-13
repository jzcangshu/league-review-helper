const ExcelJS = require("exceljs");

const { clean, detectResultColumns } = require("./review-data");

const NAME_HEADER_ALIASES = new Set([
  "姓名", "学生姓名", "团员姓名", "人员姓名", "发展对象姓名", "申请人姓名", "成员姓名"
]);
const CONTEXT_HEADER_PATTERNS = [
  /序号|编号/, /学校|单位/, /班级|班别/, /姓名|名字/, /性别/, /民族/,
  /身份证|证件/, /出生/, /籍贯|户籍/, /电话|手机|联系方式/, /宗教/, /备注|问题|审核/
];
const NON_NAME_VALUES = new Set([
  "男", "女", "是", "否", "无", "有", "汉", "汉族", "回族", "满族", "蒙古族", "壮族",
  "姓名", "学生姓名", "团员姓名", "人员姓名", "发展对象姓名", "合计", "总计", "小计", "无资料", "未审核"
]);
const NON_NAME_PARTS = [
  "学校", "中学", "书院", "学院", "班级", "序号", "编号", "姓名", "性别", "民族", "身份证",
  "出生", "籍贯", "电话", "宗教", "备注", "问题", "审核", "说明", "填写", "制表", "负责人", "老师"
];

function cellText(cell) {
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value === "object" && cell.value.richText) {
    return cell.value.richText.map((part) => part.text).join("").trim();
  }
  if (typeof cell.value === "object" && cell.value.text) return String(cell.value.text).trim();
  return String(cell.text || cell.value || "").trim();
}

function columnLetter(index) {
  let value = Number(index) + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function meaningfulColumnCount(sheet) {
  let maximum = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (cellText(cell)) maximum = Math.max(maximum, columnNumber);
    });
  });
  return maximum || sheet.actualColumnCount || sheet.columnCount || 1;
}

function meaningfulRowCount(sheet) {
  let maximum = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (row.values.some((value, index) => index > 0 && String(value ?? "").trim())) maximum = rowNumber;
  });
  return maximum || sheet.actualRowCount || sheet.rowCount || 1;
}

function normalizeHeader(value) {
  return clean(value).replace(/[（）()【】\[\]：:]/g, "");
}

function nameHeaderScore(value) {
  const header = normalizeHeader(value);
  if (!header) return 0;
  if (NAME_HEADER_ALIASES.has(header)) return header === "姓名" ? 120 : 115;
  if (header.endsWith("姓名") && header.length <= 12) return 105;
  if (header.includes("姓名") && header.length <= 16) return 95;
  if (["名字", "学生", "团员", "成员"].includes(header)) return 62;
  return 0;
}

function looksLikeStudentName(value) {
  const name = clean(value).replace(/[·•]/g, "·");
  if (!name || NON_NAME_VALUES.has(name) || name.length < 2 || name.length > 7) return false;
  if (NON_NAME_PARTS.some((part) => name.includes(part))) return false;
  if (/\d|[A-Za-z]/.test(name)) return false;
  return /^[\p{Script=Han}·]+$/u.test(name);
}

function obviousNonDataName(value) {
  const name = clean(value);
  return !name || NAME_HEADER_ALIASES.has(name) || /^(合计|总计|小计|说明|备注|制表人|审核人|负责人)[:：]?/.test(name);
}

function nameColumnProfile(sheet, headerRow, columnIndex) {
  const samples = [];
  const maximumRow = meaningfulRowCount(sheet);
  for (let rowNumber = headerRow + 1; rowNumber <= maximumRow && samples.length < 60; rowNumber += 1) {
    const value = clean(cellText(sheet.getRow(rowNumber).getCell(columnIndex + 1)));
    if (value) samples.push(value);
  }
  const likely = samples.filter(looksLikeStudentName).length;
  return {
    count: samples.length,
    likely,
    ratio: samples.length ? likely / samples.length : 0,
    samples: samples.slice(0, 5)
  };
}

function combinedHeaders(sheet, headerStartRow, headerRow, columnCount) {
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const parts = [];
    for (let rowNumber = headerStartRow; rowNumber <= headerRow; rowNumber += 1) {
      const value = cellText(sheet.getRow(rowNumber).getCell(columnIndex + 1));
      if (value && !parts.includes(value)) parts.push(value);
    }
    return parts.join(" ").trim();
  });
}

function headerContextCount(headers) {
  return CONTEXT_HEADER_PATTERNS.filter((pattern) => headers.some((header) => pattern.test(clean(header)))).length;
}

function buildLayoutCandidate(sheet, headerStartRow, headerRow) {
  const columnCount = meaningfulColumnCount(sheet);
  const headers = combinedHeaders(sheet, headerStartRow, headerRow, columnCount);
  const nameCandidates = headers.map((header, index) => {
    const profile = nameColumnProfile(sheet, headerRow, index);
    const headerScore = nameHeaderScore(header);
    return {
      index,
      header,
      headerScore,
      profile,
      score: headerScore * 2 + profile.ratio * 55 + Math.min(profile.count, 15)
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const bestName = nameCandidates[0];
  const contextCount = headerContextCount(headers);
  const resultDetection = detectResultColumns(headers);
  const hasNameEvidence = bestName && (bestName.headerScore > 0 || (bestName.profile.count >= 2 && bestName.profile.ratio >= 0.75));
  if (!hasNameEvidence) return null;
  const resultBonus = resultDetection.selected ? 18 : resultDetection.ambiguous ? 8 : 0;
  return {
    sheet: sheet.name,
    headerStartRow,
    headerRow,
    headers,
    nameColumn: bestName.index,
    nameHeaderScore: bestName.headerScore,
    nameProfile: bestName.profile,
    contextCount,
    resultDetection,
    score: bestName.score + contextCount * 14 + resultBonus + (sheet.state === "visible" ? 4 : 0)
  };
}

function allLayoutCandidates(workbook) {
  const candidates = [];
  workbook.eachSheet((sheet) => {
    const maximumRow = Math.min(80, meaningfulRowCount(sheet));
    for (let headerRow = 1; headerRow <= maximumRow; headerRow += 1) {
      for (let span = 1; span <= Math.min(3, headerRow); span += 1) {
        const candidate = buildLayoutCandidate(sheet, headerRow - span + 1, headerRow);
        if (candidate) candidates.push(candidate);
      }
    }
  });
  candidates.sort((left, right) => right.score - left.score || left.headerRow - right.headerRow);
  return candidates;
}

function requestedOptions(requested) {
  if (typeof requested === "string") return { resultColumn: requested, layout: {}, rowOverrides: {} };
  return {
    resultColumn: String(requested?.resultColumn || "").trim(),
    layout: requested?.layout && typeof requested.layout === "object" ? requested.layout : {},
    rowOverrides: requested?.rowOverrides && typeof requested.rowOverrides === "object" ? requested.rowOverrides : {}
  };
}

function manualCandidate(workbook, candidates, layout) {
  if (!layout.sheet && !layout.headerRow && !Number.isInteger(layout.nameColumn)) return null;
  const sheet = workbook.getWorksheet(layout.sheet) || workbook.worksheets[0];
  if (!sheet) throw new Error("所选 Excel 中没有可读取的工作表。");
  const headerRow = Math.max(1, Math.min(meaningfulRowCount(sheet), Number(layout.headerRow) || 1));
  const matching = candidates.filter((candidate) => candidate.sheet === sheet.name && candidate.headerRow === headerRow);
  const candidate = matching[0] || buildLayoutCandidate(sheet, headerRow, headerRow) || {
    sheet: sheet.name,
    headerStartRow: headerRow,
    headerRow,
    headers: combinedHeaders(sheet, headerRow, headerRow, meaningfulColumnCount(sheet)),
    nameColumn: 0,
    nameHeaderScore: 0,
    nameProfile: { count: 0, likely: 0, ratio: 0, samples: [] },
    contextCount: 0,
    resultDetection: { selected: null, candidates: [], ambiguous: false },
    score: 0
  };
  if (Number.isInteger(layout.nameColumn)) {
    candidate.nameColumn = layout.nameColumn;
    candidate.nameHeaderScore = nameHeaderScore(candidate.headers[layout.nameColumn]);
    candidate.nameProfile = nameColumnProfile(sheet, headerRow, layout.nameColumn);
  }
  return candidate;
}

function layoutOptions(workbook) {
  return workbook.worksheets.map((sheet) => {
    const rowCount = meaningfulRowCount(sheet);
    const columnCount = meaningfulColumnCount(sheet);
    const rows = [];
    for (let rowNumber = 1; rowNumber <= Math.min(rowCount, 80); rowNumber += 1) {
      const values = Array.from({ length: columnCount }, (_, index) =>
        cellText(sheet.getRow(rowNumber).getCell(index + 1)).slice(0, 120));
      if (values.some(Boolean)) rows.push({ rowNumber, values });
    }
    return { name: sheet.name, state: sheet.state, rowCount, columnCount, rows };
  });
}

function columnsForLayout(sheet, candidate) {
  return candidate.headers.map((header, index) => ({
    index,
    letter: columnLetter(index),
    header: header || "未命名列",
    samples: nameColumnProfile(sheet, candidate.headerRow, index).samples.slice(0, 3)
  }));
}

function chooseResultColumn(candidate, requestedResultColumn, layout) {
  if (requestedResultColumn) {
    const requestedIndex = candidate.headers.findIndex((header) => clean(header) === clean(requestedResultColumn));
    if (requestedIndex >= 0) return requestedIndex;
  }
  if (Number.isInteger(layout.resultColumn)) return layout.resultColumn;
  return candidate.resultDetection.selected?.index ?? -1;
}

async function inspectWorkbook(excelPath, requested = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const { resultColumn: requestedResultColumn, layout, rowOverrides } = requestedOptions(requested);
  const candidates = allLayoutCandidates(workbook);
  const candidate = manualCandidate(workbook, candidates, layout) || candidates[0];
  if (!candidate) throw new Error("未能可靠识别名单区域，请在预览中手动选择工作表、表头行和姓名列。");
  const sheet = workbook.getWorksheet(candidate.sheet);
  if (!sheet) throw new Error("无法打开识别出的名单工作表。");
  const resultColumn = chooseResultColumn(candidate, requestedResultColumn, layout);
  const resultHeader = resultColumn >= 0 ? candidate.headers[resultColumn] || cellText(sheet.getRow(candidate.headerRow).getCell(resultColumn + 1)) : "";
  const resultDetection = candidate.resultDetection;
  const rows = [];
  const suspiciousRows = [];
  const maximumRow = meaningfulRowCount(sheet);
  for (let rowNumber = candidate.headerRow + 1; rowNumber <= maximumRow; rowNumber += 1) {
    const sourceName = clean(cellText(sheet.getRow(rowNumber).getCell(candidate.nameColumn + 1)));
    const override = rowOverrides[String(rowNumber)] || rowOverrides[rowNumber] || {};
    const name = clean(override.name ?? sourceName);
    if (obviousNonDataName(name)) continue;
    const row = {
      rowNumber,
      name,
      sourceName,
      result: resultColumn >= 0 ? cellText(sheet.getRow(rowNumber).getCell(resultColumn + 1)) : ""
    };
    rows.push(row);
    if (!looksLikeStudentName(name)) suspiciousRows.push(rowNumber);
  }
  if (!rows.length) throw new Error("识别出的姓名列没有名单数据，请在预览中改选姓名列。");

  const warnings = [];
  const nextDistinct = candidates.find((item) =>
    item.sheet !== candidate.sheet || item.headerRow !== candidate.headerRow || item.nameColumn !== candidate.nameColumn);
  const layoutAmbiguous = !layout.confirmed && nextDistinct && candidate.score - nextDistinct.score < 18;
  if (candidate.nameHeaderScore < 80) warnings.push("姓名列表头不明确，请人工确认姓名列。");
  if (suspiciousRows.length) warnings.push(`姓名列中有 ${suspiciousRows.length} 行不像常规姓名，请检查表头行或姓名列。`);
  if (layoutAmbiguous) warnings.push("检测到多个相近的名单区域，请确认工作表和表头行。");
  if (resultDetection.ambiguous && !Number.isInteger(layout.resultColumn) && !requestedResultColumn) {
    warnings.push("检测到多个可能的审核意见列，请人工选择。");
  }
  const needsConfirmation = suspiciousRows.length > 0 || (!layout.confirmed && (
    candidate.nameHeaderScore < 80 || layoutAmbiguous ||
    (resultDetection.ambiguous && !Number.isInteger(layout.resultColumn) && !requestedResultColumn)
  ));
  const confirmed = Boolean(layout.confirmed);
  return {
    sheet: candidate.sheet,
    headerStartRow: candidate.headerStartRow,
    headerRow: candidate.headerRow,
    headers: candidate.headers,
    nameColumn: candidate.nameColumn,
    resultColumn,
    resultHeader,
    resultDetection,
    rows,
    layout: {
      sheet: candidate.sheet,
      headerStartRow: candidate.headerStartRow,
      headerRow: candidate.headerRow,
      nameColumn: candidate.nameColumn,
      resultColumn,
      confirmed,
      confidence: confirmed ? "manual" : needsConfirmation ? "low" : candidate.nameHeaderScore >= 100 ? "high" : "medium",
      needsConfirmation,
      warnings,
      suspiciousRows,
      columns: columnsForLayout(sheet, candidate),
      sheets: layoutOptions(workbook)
    }
  };
}

module.exports = {
  cellText,
  columnLetter,
  inspectWorkbook,
  looksLikeStudentName
};
