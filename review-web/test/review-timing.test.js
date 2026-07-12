const test = require("node:test");
const assert = require("node:assert/strict");

test("auto-review requires an unreviewed PDF, a page change, and ten seconds", async () => {
  const { shouldAutoMarkReviewed } = await import("../public/review-timing.js");
  const base = { reviewed: false, hasPdf: true, pageChanged: true, startedAt: 1000, now: 11000 };
  assert.equal(shouldAutoMarkReviewed(base), true);
  assert.equal(shouldAutoMarkReviewed({ ...base, reviewed: true }), false);
  assert.equal(shouldAutoMarkReviewed({ ...base, hasPdf: false }), false);
  assert.equal(shouldAutoMarkReviewed({ ...base, pageChanged: false }), false);
  assert.equal(shouldAutoMarkReviewed({ ...base, now: 10999 }), false);
});
