const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");

const { analyzeImport, commitImport } = require("../lib/import-service");

async function createFixture(rows) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-import-"));
  const pdfDir = path.join(root, "资料");
  const reviewRoot = path.join(root, "审核结果");
  const excelPath = path.join(root, "名单.xlsx");
  await fs.mkdir(pdfDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("名单");
  sheet.addRow(["姓名", "入团志愿书问题备注"]);
  for (const row of rows) {
    sheet.addRow([row.name, row.result]);
    await fs.writeFile(path.join(pdfDir, `${row.name}.pdf`), "%PDF-1.4\n", "utf8");
  }
  await workbook.xlsx.writeFile(excelPath);
  return { root, pdfDir, reviewRoot, excelPath };
}

test("imports historical Excel results and creates missing review files", async () => {
  const fixture = await createFixture([
    { name: "张三", result: "上级团委未盖章" },
    { name: "李四", result: "" }
  ]);

  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  assert.equal(analysis.summary.pdfCount, 2);
  assert.equal(analysis.summary.historyCount, 1);
  assert.equal(analysis.summary.conflictCount, 0);

  const result = await commitImport({ analysis, resolutions: {} });
  assert.equal(result.created, 2);
  assert.equal(
    await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "张三_审核结果.txt"), "utf8"),
    "上级团委未盖章"
  );
  assert.equal(await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "李四_审核结果.txt"), "utf8"), "");
});

test("keeps non-empty TXT by default and backs up confirmed replacements", async () => {
  const fixture = await createFixture([{ name: "张三", result: "学校修改后的复审意见" }]);
  const schoolReviewDir = path.join(fixture.reviewRoot, "示例中学");
  await fs.mkdir(schoolReviewDir, { recursive: true });
  await fs.writeFile(path.join(schoolReviewDir, "张三_审核结果.txt"), "本地原审核意见", "utf8");

  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  assert.equal(analysis.summary.conflictCount, 1);

  await commitImport({ analysis, resolutions: {} });
  assert.equal(await fs.readFile(path.join(schoolReviewDir, "张三_审核结果.txt"), "utf8"), "本地原审核意见");

  const replaced = await commitImport({ analysis, resolutions: { 张三: "use_excel" } });
  assert.equal(await fs.readFile(path.join(schoolReviewDir, "张三_审核结果.txt"), "utf8"), "学校修改后的复审意见");
  assert.equal(replaced.backedUp, 1);
  assert.ok(replaced.backupDir);
});

test("does not import the generated missing-material sentinel", async () => {
  const fixture = await createFixture([{ name: "张三", result: "无资料" }]);
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  assert.equal(analysis.items[0].conflict.action, "skip_missing_sentinel");
  await commitImport({ analysis, resolutions: {} });
  assert.equal(
    await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "张三_审核结果.txt"), "utf8"),
    ""
  );
});

test("blocks commit when duplicate names could collide", async () => {
  await assert.rejects(
    commitImport({
      analysis: { needsResultColumn: false, duplicates: { excel: ["张三"], pdf: [] } },
      resolutions: {}
    }),
    /重复姓名/
  );
});
