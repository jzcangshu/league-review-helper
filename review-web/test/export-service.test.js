const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");

const { writeSchoolResultsToExcel } = require("../lib/export-service");

test("writes school results and appends missing names only once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-export-"));
  const excelPath = path.join(root, "名单.xlsx");
  const reviewDir = path.join(root, "审核结果", "示例中学");
  await fs.mkdir(reviewDir, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("名单");
  sheet.addRow(["姓名", "问题备注"]);
  sheet.addRow(["张三", "旧结果"]);
  sheet.addRow(["赵六", "旧结果"]);
  await workbook.xlsx.writeFile(excelPath);

  const createItem = async (name, reviewed, content) => {
    const reviewPath = path.join(reviewDir, `${name}_审核结果.txt`);
    await fs.writeFile(reviewPath, content, "utf8");
    return { studentName: name, reviewed, reviewPath, pdfPath: path.join(root, `${name}.pdf`) };
  };
  const items = [
    await createItem("张三", true, "新结果"),
    await createItem("李四", true, ""),
    await createItem("王五", false, "")
  ];
  const now = new Date(2026, 6, 14, 15, 6, 7);
  const first = await writeSchoolResultsToExcel({ workspaceRoot: root, school: "示例中学", excelPath, items, now });
  assert.equal(first.appended, 2);
  assert.equal(first.reviewed, 2);
  assert.equal(first.pending, 1);
  assert.equal(first.missing, 1);
  assert.equal(path.basename(first.excelPath), "名单_7月14日_150607_审核回填.xlsx");
  assert.equal(first.sourceExcelPath, excelPath);

  const second = await writeSchoolResultsToExcel({ workspaceRoot: root, school: "示例中学", excelPath, items, now });
  assert.equal(path.basename(second.excelPath), "名单_7月14日_150607_审核回填(2).xlsx");
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(first.excelPath);
  const names = check.getWorksheet("名单").getColumn(1).values.filter(Boolean);
  assert.deepEqual(names, ["姓名", "张三", "赵六", "李四", "王五"]);
  assert.equal(check.getWorksheet("名单").getCell("B2").value, "新结果");
  assert.equal(check.getWorksheet("名单").getCell("B3").value, "无资料");
  assert.equal(check.getWorksheet("名单").getCell("B4").value, null);
  assert.equal(check.getWorksheet("名单").getCell("B5").value, "未审核");
  assert.equal(check.getWorksheet("名单").getCell("B2").font.color.argb, "FF000000");
  assert.equal(check.getWorksheet("名单").getCell("B3").font.color.argb, "FFFF0000");
  assert.equal(check.getWorksheet("名单").getCell("B4").font.color.argb, "FF000000");
  assert.equal(check.getWorksheet("名单").getCell("B5").font.color.argb, "FF000000");
  const original = new ExcelJS.Workbook();
  await original.xlsx.readFile(excelPath);
  assert.equal(original.getWorksheet("名单").getCell("B2").value, "旧结果");
  assert.equal(original.getWorksheet("名单").getCell("B3").value, "旧结果");
  assert.equal(first.folderPath, root);
});

test("write-back reuses an exact generic remarks column", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-export-remarks-"));
  const excelPath = path.join(root, "名单.xlsx");
  const reviewDir = path.join(root, "审核结果", "示例中学");
  await fs.mkdir(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, "张三_审核结果.txt");
  await fs.writeFile(reviewPath, "新审核意见", "utf8");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("名单");
  sheet.addRow(["序号", "姓名", "备注"]);
  sheet.addRow([1, "张三", "旧审核意见"]);
  await workbook.xlsx.writeFile(excelPath);

  const result = await writeSchoolResultsToExcel({
    workspaceRoot: root,
    school: "示例中学",
    excelPath,
    items: [{ studentName: "张三", reviewed: true, reviewPath, pdfPath: path.join(root, "张三.pdf") }]
  });
  assert.equal(result.resultColumn, "备注");
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(result.excelPath);
  assert.equal(check.getWorksheet("名单").getCell("C2").value, "新审核意见");
  assert.equal(check.getWorksheet("名单").getCell("D1").value, null);
});
