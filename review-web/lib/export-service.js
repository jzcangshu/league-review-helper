const fsp = require("node:fs/promises");
const path = require("node:path");
const ExcelJS = require("exceljs");

const { inspectWorkbook } = require("./import-service");
const { clean } = require("./review-data");

function outputTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function availableOutputPath(excelPath, date) {
  const extension = path.extname(excelPath);
  const baseName = path.basename(excelPath, extension);
  const stem = `${baseName}_${outputTimestamp(date)}_审核回填`;
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `(${index})`;
    const candidate = path.join(path.dirname(excelPath), `${stem}${suffix}${extension}`);
    try {
      await fsp.access(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
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
  const layout = { ...(options.layout || {}) };
  if (layout.resultColumn < 0) delete layout.resultColumn;
  const roster = await inspectWorkbook(excelPath, {
    resultColumn: options.resultColumn || "",
    layout
  });
  if (roster.layout.needsConfirmation) {
    return {
      needsLayoutConfirmation: true,
      layoutWarnings: roster.layout.warnings
    };
  }
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
    setFontColor(row.getCell(roster.nameColumn + 1), "FF000000");
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
      setFontColor(cell, "FF000000");
      pending += 1;
      continue;
    }
    const content = await fsp.readFile(item.reviewPath, "utf8").catch(() => "");
    cell.value = content.trim() || null;
    setFontColor(cell, "FF000000");
    reviewed += 1;
  }

  const outputPath = await availableOutputPath(excelPath, options.now || new Date());
  await workbook.xlsx.writeFile(outputPath);

  return {
    needsResultColumn: false,
    resultColumn: sheet.getRow(roster.headerRow).getCell(resultColumn + 1).text,
    reviewed,
    pending,
    missing,
    appended: additions.length,
    sourceExcelPath: excelPath,
    excelPath: outputPath,
    folderPath: path.dirname(outputPath),
    layout: {
      sheet: roster.sheet,
      headerRow: roster.headerRow,
      nameColumn: roster.nameColumn,
      resultColumn,
      confirmed: true
    }
  };
}

module.exports = { writeSchoolResultsToExcel };
