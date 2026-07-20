const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const packagingRoot = path.join(repoRoot, "packaging", "windows");

test("Windows installer is per-user, x64-only and creates professional shortcuts", () => {
  const source = fs.readFileSync(path.join(packagingRoot, "installer.iss"), "utf8");
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.match(source, /ArchitecturesAllowed=x64compatible/);
  assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\LeagueReviewHelper/);
  assert.match(source, /LeagueReviewHelper\.exe/);
  assert.match(source, /\[Icons\]/);
  assert.match(source, /UninstallDisplayIcon/);
});

test("native launcher uses the packaged runtimes and opens a verified local service", () => {
  const source = fs.readFileSync(path.join(packagingRoot, "LeagueReviewHelperLauncher.cs"), "utf8");
  assert.match(source, /runtime["']?,\s*["']node/);
  assert.match(source, /REVIEW_OCR_RUNTIME_PYTHON/);
  assert.match(source, /CreateNoWindow\s*=\s*true/);
  assert.match(source, /\/api\/health/);
  assert.match(source, /UseShellExecute\s*=\s*true/);
});

test("offline build pins runtimes and preloads dependencies and OCR models", () => {
  const source = fs.readFileSync(path.join(packagingRoot, "build-offline-installer.ps1"), "utf8");
  assert.match(source, /NodeVersion\s*=\s*'22\.19\.0'/);
  assert.match(source, /PythonVersion\s*=\s*'3\.11\.9'/);
  assert.match(source, /'npm\.cmd'/);
  assert.match(source, /& \$npm ci --omit=dev/);
  assert.match(source, /paddleocr==3\.7\.0/);
  assert.match(source, /pypdfium2/);
  assert.match(source, /PADDLE_PDX_CACHE_HOME/);
  assert.match(source, /ISCC\.exe/);
});

test("offline package carries third-party redistribution notices", () => {
  const source = fs.readFileSync(path.join(packagingRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const dependency of ["Node.js", "Python", "PaddleOCR", "ONNX Runtime", "pypdfium2", "PDFium"])
    assert.match(source, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
