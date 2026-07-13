const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ExcelJS = require("exceljs");

const { inspectWorkbook } = require("../lib/import-service");

async function temporaryWorkbook(build) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-excel-layout-"));
  const excelPath = path.join(root, "名单.xlsx");
  const workbook = new ExcelJS.Workbook();
  await build(workbook);
  await workbook.xlsx.writeFile(excelPath);
  return excelPath;
}

test("exact 备注 is used as the historical review column", async () => {
  const excelPath = await temporaryWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet("名单");
    sheet.addRow(["2026 年团员名单"]);
    sheet.addRow(["序号", "学校", "班级", "姓名", "性别", "备注"]);
    sheet.addRow([1, "示例中学", "901", "张三", "男", "本人经历缺少职位"]);
    sheet.addRow([2, "示例中学", "901", "李四", "女", ""]);
  });

  const roster = await inspectWorkbook(excelPath);
  assert.equal(roster.sheet, "名单");
  assert.equal(roster.headerRow, 2);
  assert.equal(roster.nameColumn, 3);
  assert.equal(roster.resultHeader, "备注");
  assert.deepEqual(roster.rows.map((row) => [row.name, row.result]), [
    ["张三", "本人经历缺少职位"],
    ["李四", ""]
  ]);
});

test("roster detection prefers semantic headers over a larger instruction sheet", async () => {
  const excelPath = await temporaryWorkbook(async (workbook) => {
    const instructions = workbook.addWorksheet("填写说明");
    for (let row = 1; row <= 80; row += 1) instructions.addRow([`第 ${row} 条说明`, "请认真填写"]);
    const roster = workbook.addWorksheet("发展对象");
    roster.addRow(["标题"]);
    roster.addRow(["学校", "学生姓名", "班级", "审核意见"]);
    roster.addRow(["示例中学", "欧阳晨", "901", "无盖章"]);
    roster.addRow(["示例中学", "赵一", "902", ""]);
  });

  const roster = await inspectWorkbook(excelPath);
  assert.equal(roster.sheet, "发展对象");
  assert.equal(roster.nameColumn, 1);
  assert.equal(roster.resultHeader, "审核意见");
  assert.deepEqual(roster.rows.map((row) => row.name), ["欧阳晨", "赵一"]);
});

test("multi-row headers are combined when detecting columns", async () => {
  const excelPath = await temporaryWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet("名单");
    sheet.addRow(["基本信息", "基本信息", "审核"]);
    sheet.addRow(["学校", "学生", "历史"]);
    sheet.addRow(["", "姓名", "问题备注"]);
    sheet.addRow(["示例中学", "司马航", "材料不完整"]);
  });

  const roster = await inspectWorkbook(excelPath);
  assert.equal(roster.headerRow, 3);
  assert.equal(roster.nameColumn, 1);
  assert.equal(roster.resultColumn, 2);
  assert.equal(roster.rows[0].name, "司马航");
});

test("manual layout selection repairs an unknown workbook form", async () => {
  const excelPath = await temporaryWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet("数据区");
    sheet.addRow(["内部报表"]);
    sheet.addRow(["编号", "成员", "班组", "状态", "旧记录"]);
    sheet.addRow([1, "陈小满", "一组", "完成", "扫描模糊"]);
    sheet.addRow([2, "林知夏", "二组", "完成", ""]);
  });

  const roster = await inspectWorkbook(excelPath, {
    layout: {
      sheet: "数据区",
      headerRow: 2,
      nameColumn: 1,
      resultColumn: 4,
      confirmed: true
    }
  });
  assert.equal(roster.layout.confirmed, true);
  assert.deepEqual(roster.rows.map((row) => [row.name, row.result]), [
    ["陈小满", "扫描模糊"],
    ["林知夏", ""]
  ]);
});

test("suspicious name values require layout confirmation instead of silent trust", async () => {
  const excelPath = await temporaryWorkbook(async (workbook) => {
    const sheet = workbook.addWorksheet("名单");
    sheet.addRow(["姓名", "问题备注"]);
    sheet.addRow(["男", ""]);
    sheet.addRow(["女", ""]);
  });

  const roster = await inspectWorkbook(excelPath);
  assert.equal(roster.layout.needsConfirmation, true);
  assert.ok(roster.layout.warnings.some((warning) => warning.includes("姓名列")));

  const corrected = await inspectWorkbook(excelPath, {
    layout: { sheet: "名单", headerRow: 1, nameColumn: 0, resultColumn: 1, confirmed: true },
    rowOverrides: { 2: { name: "张三" }, 3: { name: "李四" } }
  });
  assert.equal(corrected.layout.needsConfirmation, false);
  assert.deepEqual(corrected.rows.map((row) => [row.sourceName, row.name]), [["男", "张三"], ["女", "李四"]]);
});
