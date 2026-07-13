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

test("requires manual confirmation for a fuzzy name and can append the PDF name to Excel", async () => {
  const fixture = await createFixture([{ name: "张三", result: "" }]);
  await fs.rename(path.join(fixture.pdfDir, "张三.pdf"), path.join(fixture.pdfDir, "张珊.pdf"));
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  assert.equal(analysis.items[0].matchKind, "fuzzy");
  await assert.rejects(commitImport({ analysis }), /请确认/);

  const result = await commitImport({ analysis, bindings: { 张珊: "__append__" } });
  assert.equal(result.appended, 1);
  assert.ok(result.excelBackupPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.excelPath);
  const names = workbook.getWorksheet("名单").getColumn(1).values;
  assert.ok(names.includes("张珊"));
  assert.ok(names.includes("张三"));
  assert.equal(await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "张珊_审核结果.txt"), "utf8"), "");
});

test("excludes roster names already claimed by exact PDFs from fuzzy candidates", async () => {
  const fixture = await createFixture([
    { name: "林小辰", result: "" },
    { name: "林小鑫", result: "" }
  ]);
  await fs.rename(path.join(fixture.pdfDir, "林小辰.pdf"), path.join(fixture.pdfDir, "林小晨.pdf"));
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  const item = analysis.items.find((entry) => entry.name === "林小晨");
  assert.equal(item.matchKind, "fuzzy");
  assert.equal(item.excelName, "林小辰");
  assert.deepEqual(item.matchCandidates, []);
});

test("ambiguous PDF can be kept as a different person and appended once", async () => {
  const fixture = await createFixture([
    { name: "林小辰", result: "" },
    { name: "林小鑫", result: "" }
  ]);
  await fs.rename(path.join(fixture.pdfDir, "林小辰.pdf"), path.join(fixture.pdfDir, "林小晨.pdf"));
  await fs.rename(path.join(fixture.pdfDir, "林小鑫.pdf"), path.join(fixture.pdfDir, "李四.pdf"));
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  const ambiguous = analysis.items.find((entry) => entry.name === "林小晨");
  assert.equal(ambiguous.matchKind, "ambiguous");
  assert.deepEqual(ambiguous.matchCandidates, ["林小辰", "林小鑫"]);

  const result = await commitImport({
    analysis,
    bindings: { 林小晨: "__append__", 李四: "__skip__" }
  });
  assert.equal(result.appended, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.excelPath);
  const names = workbook.getWorksheet("名单").getColumn(1).values;
  assert.equal(names.filter((name) => name === "林小晨").length, 1);
  assert.ok(names.includes("林小辰"));
  assert.ok(names.includes("林小鑫"));
});

test("uses the Excel name as canonical and renames the PDF and review TXT", async () => {
  const fixture = await createFixture([{ name: "张三", result: "" }]);
  await fs.rename(path.join(fixture.pdfDir, "张三.pdf"), path.join(fixture.pdfDir, "张珊.pdf"));
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  await commitImport({ analysis, bindings: { 张珊: "excel:张三" } });
  assert.equal(await fs.readFile(path.join(fixture.pdfDir, "张三.pdf"), "utf8"), "%PDF-1.4\n");
  assert.equal(await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "张三_审核结果.txt"), "utf8"), "");
});

test("uses the PDF name as canonical and updates the Excel roster name", async () => {
  const fixture = await createFixture([{ name: "张三", result: "" }]);
  await fs.rename(path.join(fixture.pdfDir, "张三.pdf"), path.join(fixture.pdfDir, "张珊.pdf"));
  const analysis = await analyzeImport({
    workspaceRoot: fixture.root,
    reviewRoot: fixture.reviewRoot,
    school: "示例中学",
    pdfDir: fixture.pdfDir,
    excelPath: fixture.excelPath
  });
  await commitImport({ analysis, bindings: { 张珊: "pdf:张三" } });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.excelPath);
  assert.equal(workbook.getWorksheet("名单").getCell("A2").value, "张珊");
  assert.equal(await fs.readFile(path.join(fixture.reviewRoot, "示例中学", "张珊_审核结果.txt"), "utf8"), "");
});

test("confirmed preview correction is backed up and written to the original Excel row", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-row-fix-"));
  const pdfDir = path.join(root, "资料");
  const reviewRoot = path.join(root, "审核结果");
  const excelPath = path.join(root, "名单.xlsx");
  await fs.mkdir(pdfDir, { recursive: true });
  await fs.writeFile(path.join(pdfDir, "张珊.pdf"), "%PDF-1.4\n", "utf8");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("名单");
  sheet.addRow(["姓名", "问题备注"]);
  sheet.addRow(["张三→张珊？", "学校复审意见"]);
  await workbook.xlsx.writeFile(excelPath);

  const analysis = await analyzeImport({
    workspaceRoot: root,
    reviewRoot,
    school: "示例中学",
    pdfDir,
    excelPath,
    layout: { sheet: "名单", headerRow: 1, nameColumn: 0, resultColumn: 1, confirmed: true },
    rowOverrides: { 2: { name: "张珊" } }
  });
  assert.equal(analysis.items[0].matchKind, "exact");
  const result = await commitImport({ analysis });
  assert.equal(result.renamed, 1);
  assert.ok(result.excelBackupPath);

  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(excelPath);
  assert.equal(check.getWorksheet("名单").getCell("A2").value, "张珊");
});
