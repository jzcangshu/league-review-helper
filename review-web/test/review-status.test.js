const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { isExplicitlyReviewed, loadReviewStatus, setReviewed } = require("../lib/review-status");

test("tracks an explicitly reviewed empty result without changing the TXT", async () => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-status-"));
  assert.equal(isExplicitlyReviewed(await loadReviewStatus(reviewDir), "张三"), false);
  await setReviewed(reviewDir, "张三", true);
  assert.equal(isExplicitlyReviewed(await loadReviewStatus(reviewDir), "张三"), true);
  await setReviewed(reviewDir, "张三", false);
  assert.equal(isExplicitlyReviewed(await loadReviewStatus(reviewDir), "张三"), false);
});

test("does not silently overwrite a damaged review status file", async () => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-status-"));
  await fs.writeFile(path.join(reviewDir, ".review-status.json"), "{broken", "utf8");
  await assert.rejects(setReviewed(reviewDir, "张三", true), /格式损坏/);
});
