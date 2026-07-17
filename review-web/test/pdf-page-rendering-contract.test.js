const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

test("main PDF page renders offscreen before replacing the visible canvas", () => {
  const renderFunction = app.match(/async function renderPdfPage\([\s\S]*?\n}\n\nfunction updateActiveThumbnail/);
  assert.ok(renderFunction, "未找到主 PDF 页面渲染函数");
  assert.match(app, /function createPdfRenderCanvas[\s\S]*?document\.createElement\("canvas"\)/);
  assert.match(renderFunction[0], /entry = await renderPdfPageOffscreen\(page, spec\)[\s\S]*?presentPdfPage\(entry\)/);
  assert.doesNotMatch(renderFunction[0], /page\.render\(/);
});

test("PDF page rendering uses a bounded cache and idle adjacent-page prefetch", () => {
  assert.match(app, /createPdfPageCache\(\{ maxEntries: 4 \}\)/);
  assert.match(app, /function scheduleAdjacentPdfPagePrefetch\(\)/);
  assert.match(app, /requestIdleCallback\(run, \{ timeout: 450 \}\)/);
  assert.match(app, /scheduleAdjacentPdfPagePrefetch\(\)/);
});
