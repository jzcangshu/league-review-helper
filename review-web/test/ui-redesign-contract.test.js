const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const theme = fs.readFileSync(path.join(publicDir, "emil-theme.css"), "utf8");

const requiredIds = [
  "studentTitle", "studentMeta", "prevButton", "nextButton",
  "importStatus", "manageSchoolsButton", "importProgress", "pickPdfFolderButton", "pickExcelButton",
  "schoolSelect", "studentSelect", "saveStatus",
  "reviewText", "reviewStateButton", "editNotesButton", "noteList",
  "shortcutToolTab", "exportToolTab", "shortcutList", "writeBackExcelButton",
  "prevPageButton", "nextPageButton", "pageIndicator", "zoomOutButton", "zoomInButton", "rotateButton",
  "ocrToggleButton", "ocrStatus", "downloadButton", "pdfThumbnails", "pdfStage", "ocrReviewRail",
  "issuesDialog", "schoolsDialog", "notesDialog", "aboutProjectDialog", "feedbackProjectDialog", "updateDialog"
];

test("UI 重设计保留全部核心业务控件", () => {
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `缺少核心控件 #${id}`);
  }
});

test("所有脚本依赖的元素 ID 都存在于页面", () => {
  const idsBlock = app.match(/const elementIds = \[([\s\S]*?)\];/);
  assert.ok(idsBlock, "未找到 app.js 的 elementIds 契约");
  const ids = [...idsBlock[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);

  assert.ok(ids.length > 80, "元素契约数量异常");
  for (const id of ids) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `页面缺少 app.js 依赖的 #${id}`);
  }
});

test("页面继续使用原有业务脚本入口", () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/emil-theme\.css" \/>/);
});

test("设计系统遵守高频交互和无障碍约束", () => {
  assert.doesNotMatch(theme, /transition\s*:\s*all\b/);
  assert.doesNotMatch(theme, /\bease-in\b(?!-out)/);
  assert.match(theme, /button:active\s*\{[\s\S]*?transform:\s*scale\(0\.97\)/);
  assert.match(theme, /:focus-visible/);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
});

test("界面保持单屏左右审核工作台结构", () => {
  assert.match(theme, /\.app-shell\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(theme, /height:\s*100dvh/);
  assert.match(theme, /\.pdf-workspace\s*\{[\s\S]*?grid-template-columns:/);
});

test("左侧审核区使用随窗口变化的字号和宽度", () => {
  assert.match(theme, /--apple-body-size:\s*clamp\(15px,/);
  assert.match(theme, /\.left-pane\s*\{[\s\S]*?font-size:\s*var\(--left-base-size\)/);
  assert.match(theme, /grid-template-columns:\s*clamp\(700px,\s*40vw,\s*1040px\)/);
  assert.match(theme, /\.left-pane \.panel-head\s*\{[\s\S]*?font-size:\s*clamp\(20px,/);
});

test("OCR 标注具有明确的开关结构和无障碍状态", () => {
  assert.match(html, /id="ocrToggleButton"[^>]*role="switch"[^>]*aria-checked="true"/);
  assert.match(html, /class="ocr-switch-track"/);
  assert.match(html, /class="ocr-switch-thumb"/);
  assert.match(app, /ocrToggleButton\.setAttribute\("aria-checked",\s*String\(state\.ocrEnabled\)\)/);
  assert.match(theme, /\.toolbar-ocr-group\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent/);
  assert.match(theme, /\.ocr-toggle\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent/);
});

test("OCR 核验结果使用整卡状态底色支持快速扫视", () => {
  assert.match(theme, /\.ocr-review-list\s*\{[\s\S]*?display:\s*flex/);
  assert.match(theme, /\.ocr-review-item\s*\{[\s\S]*?border-radius:\s*var\(--radius-md\)/);
  assert.match(theme, /\.ocr-review-item\.pending\s*\{[\s\S]*?background:\s*rgba\(199,\s*106,\s*0,/);
  assert.match(theme, /\.ocr-review-item\.pass\s*\{[\s\S]*?background:\s*rgba\(22,\s*136,\s*95,/);
  assert.match(theme, /\.ocr-review-item\.fail\s*\{[\s\S]*?background:\s*rgba\(217,\s*45,\s*32,/);
});

test("左侧静态状态与可点击操作具有明显不同的视觉语法", () => {
  assert.match(theme, /#importStatus,\s*#saveStatus\s*\{[\s\S]*?background:\s*transparent[\s\S]*?border-radius:\s*0/);
  assert.match(theme, /#importStatus::before,\s*#saveStatus::before\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(theme, /#manageSchoolsButton,\s*#reviewStateButton,\s*#editNotesButton\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?box-shadow:/);
});

test("名单标题不再显示冗余的 PDF 匹配状态", () => {
  assert.doesNotMatch(html, /id="pdfStatus"/);
  assert.doesNotMatch(app, /elements\.pdfStatus/);
});

test("小键盘提示与快捷短语标题处于同一行", () => {
  assert.match(html, /id="shortcutToolTab"[\s\S]*?快捷短语<span class="shortcut-tab-hint">（小键盘快速插入）<\/span>/);
  assert.doesNotMatch(html, /class="utility-panel-head hint">小键盘/);
});

test("快捷短语工具区由实际内容决定高度而非固定留白", () => {
  assert.match(theme, /\.utility-dock\s*\{[\s\S]*?flex:\s*0 0 auto[\s\S]*?min-height:\s*0/);
});

test("资料选择提示占满进度条下方空间并垂直居中", () => {
  assert.match(theme, /\.import-body\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(theme, /\.guided-import-action\s*\{[\s\S]*?height:\s*100%[\s\S]*?align-content:\s*center[\s\S]*?justify-items:\s*center/);
});

test("OCR 核验栏使用适合桌面审核的清晰字号", () => {
  assert.match(theme, /\.pdf-workspace\s*\{[\s\S]*?clamp\(226px,\s*12vw,\s*264px\)/);
  assert.match(theme, /\.ocr-review-head strong\s*\{[\s\S]*?font-size:\s*22px/);
  assert.match(theme, /\.ocr-review-label\s*\{[\s\S]*?font-size:\s*19px/);
  assert.match(theme, /\.ocr-review-detail\s*\{[\s\S]*?font-size:\s*17px/);
});

test("Apple 设计层使用系统字体、清晰字号和足够点击面积", () => {
  assert.match(theme, /--apple-body-size:\s*clamp\(15px,/);
  assert.match(theme, /font-family:\s*-apple-system,/);
  assert.match(theme, /\.left-pane :is\(button, select, input\)\s*\{[\s\S]*?min-height:\s*40px/);
  assert.match(theme, /\.left-pane \.panel-head\s*\{[\s\S]*?font-size:\s*clamp\(20px,/);
  assert.match(theme, /#ocrToggleButton,[\s\S]*?background:\s*transparent/);
});

test("Apple 设计层用材质建立层级并支持减少透明度", () => {
  assert.match(theme, /\.left-pane\s*\{[\s\S]*?backdrop-filter:\s*blur\(/);
  assert.match(theme, /\.pdf-toolbar\s*\{[\s\S]*?backdrop-filter:\s*blur\(/);
  assert.match(theme, /@media \(prefers-reduced-transparency: reduce\)/);
});
