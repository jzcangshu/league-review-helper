const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "..", "public");

test("更新弹窗同时提供国内和国外下载入口", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");

  assert.match(html, /href="https:\/\/gitee\.com\/jzcangshu\/league-review-helper\/releases"/);
  assert.match(html, />国内下载（Gitee）<\/a>/);
  assert.match(html, />国外下载（GitHub）<\/a>/);
  assert.match(app, /elements\.updateDownloadActions\.hidden = false/);
});
