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
  const first = await writeSchoolResultsToExcel({ workspaceRoot: root, school: "示例中学", excelPath, items });
  assert.equal(first.appended, 2);
  assert.equal(first.reviewed, 2);
  assert.equal(first.pending, 1);

  const second = await writeSchoolResultsToExcel({ workspaceRoot: root, school: "示例中学", excelPath, items });
  assert.equal(second.appended, 0);
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(excelPath);
  const names = check.getWorksheet("名单").getColumn(1).values.filter(Boolean);
  assert.deepEqual(names, ["姓名", "张三", "李四", "王五"]);
  assert.equal(check.getWorksheet("名单").getCell("B2").value, "新结果");
  assert.equal(check.getWorksheet("名单").getCell("B3").value, null);
  assert.equal(check.getWorksheet("名单").getCell("B4").value, "未审核");
});
