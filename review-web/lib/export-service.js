const fsp = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");

const { inspectWorkbook } = require("./import-service");
const { clean } = require("./review-data");

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function setFontColor(cell, argb = null) {
  const font = { ...(cell.font || {}) };
  if (argb) font.color = { argb };
  else delete font.color;
  cell.font = font;
}

async function writeSchoolResultsToExcel(options) {
  const excelPath = path.resolve(options.excelPath);
  if (path.extname(excelPath).toLowerCase() !== ".xlsx") {
    throw new Error("带宏 Excel 无法安全自动回填，请先另存为 .xlsx。");
  }
  const roster = await inspectWorkbook(excelPath, options.resultColumn || "");
  if (roster.resultDetection.ambiguous && !options.resultColumn) {
    return {
      needsResultColumn: true,
      resultColumnChoices: roster.resultDetection.candidates.map((item) => item.header)
    };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(roster.sheet);
  if (!sheet) throw new Error("无法重新打开名单工作表。");

  let resultColumn = roster.resultColumn;
  if (resultColumn < 0) {
    resultColumn = sheet.columnCount;
    sheet.getRow(roster.headerRow).getCell(resultColumn + 1).value = "问题备注";
  }

  const uniqueItems = new Map();
  for (const item of options.items || []) {
    const name = clean(item.studentName);
    if (name && !uniqueItems.has(name)) uniqueItems.set(name, item);
  }
  const existingNames = new Set(roster.rows.map((row) => clean(row.name)).filter(Boolean));
  const additions = [...uniqueItems.entries()]
    .filter(([name, item]) => item.pdfPath && !existingNames.has(name))
    .map(([name, item]) => ({ name, item }));

  let insertAt = Math.max(roster.headerRow + 1, ...roster.rows.map((row) => row.rowNumber)) + 1;
  const styleSource = sheet.getRow(insertAt - 1);
  for (const addition of additions) {
    const row = sheet.insertRow(insertAt, []);
    row.height = styleSource.height;
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      row.getCell(column).style = { ...styleSource.getCell(column).style };
    }
    row.getCell(roster.nameColumn + 1).value = addition.name;
    roster.rows.push({ rowNumber: insertAt, name: addition.name, result: "" });
    existingNames.add(addition.name);
    insertAt += 1;
  }

  let reviewed = 0;
  let pending = 0;
  let missing = 0;
  for (const rowInfo of roster.rows) {
    const name = clean(rowInfo.name);
    if (!name) continue;
    const item = uniqueItems.get(name);
    const cell = sheet.getRow(rowInfo.rowNumber).getCell(resultColumn + 1);
    if (!item || !item.pdfPath) {
      cell.value = "无资料";
      setFontColor(cell, "FFFF0000");
      missing += 1;
      continue;
    }
    if (!item.reviewed) {
      cell.value = "未审核";
      setFontColor(cell, "FFC65911");
      pending += 1;
      continue;
    }
    const content = await fsp.readFile(item.reviewPath, "utf8").catch(() => "");
    cell.value = content.trim() || null;
    setFontColor(cell);
    reviewed += 1;
  }

  const backupDir = path.join(options.workspaceRoot, "Excel历史", options.school, `整校回填-${safeTimestamp()}`);
  await fsp.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(excelPath));
  await fsp.copyFile(excelPath, backupPath);
  await workbook.xlsx.writeFile(excelPath);

  return {
    needsResultColumn: false,
    resultColumn: sheet.getRow(roster.headerRow).getCell(resultColumn + 1).text,
    reviewed,
    pending,
    missing,
    appended: additions.length,
    backupPath
  };
}

module.exports = { writeSchoolResultsToExcel };
