const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyReviewConflict,
  detectResultColumns,
  isSchoolActive,
  migrateSource,
  normalizeStudentName,
  updateSourceState
} = require("../lib/review-data");

test("normalizes common class and application labels", () => {
  assert.equal(normalizeStudentName("803班 张三 入团志愿书_20260702_0001.pdf"), "张三");
  assert.equal(normalizeStudentName("转PDF-李铭申请书.pdf"), "李铭");
});

test("detects result columns by priority", () => {
  const headers = ["姓名", "普通备注", "问题备注", "入团志愿书问题备注（复审）"];
  const result = detectResultColumns(headers);
  assert.equal(result.selected.header, "入团志愿书问题备注（复审）");
  assert.equal(result.selected.priority, 1);
});

test("does not treat arbitrary suffix notes as the exact note fallback", () => {
  const result = detectResultColumns(["姓名", "班级备注"]);
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates, []);
});

test("classifies repeat-review conflicts conservatively", () => {
  assert.equal(classifyReviewConflict("上级团委未盖章", false, "").action, "create_from_excel");
  assert.equal(classifyReviewConflict("上级团委未盖章", true, "").action, "fill_empty");
  assert.equal(classifyReviewConflict("上级团委未盖章", true, "上级团委未盖章").action, "same");
  assert.equal(classifyReviewConflict("", true, "本地已有结论").action, "keep_txt");
  assert.equal(classifyReviewConflict("新结论", true, "旧结论").action, "conflict");
  assert.equal(classifyReviewConflict("无资料", true, "本地已有结论").action, "skip_missing_sentinel");
});

test("migrates legacy source entries without losing compatibility", () => {
  const source = migrateSource({
    school: "示例中学",
    folderRelativePath: "examples\\示例中学\\入团申请资料"
  });
  assert.equal(source.school, "示例中学");
  assert.equal(source.folderPath, "examples\\示例中学\\入团申请资料");
  assert.equal(source.active, true);
  assert.ok(source.id.startsWith("school-"));
});

test("disables and restores a school without removing its source", () => {
  const source = migrateSource({ school: "示例中学", folderRelativePath: "examples\\示例中学" });
  const disabled = updateSourceState([source], source.id, false);
  assert.equal(disabled[0].active, false);
  assert.equal(isSchoolActive("示例中学", disabled), false);
  const restored = updateSourceState(disabled, source.id, true);
  assert.equal(restored[0].active, true);
  assert.equal(isSchoolActive("示例中学", restored), true);
  assert.equal(restored[0].folderPath, source.folderPath);
});
