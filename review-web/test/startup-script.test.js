const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.resolve(__dirname, "..", "..");

test("Windows launcher uses npm.cmd and keeps startup errors visible", () => {
  const powershellBuffer = fs.readFileSync(path.join(repoRoot, "start-review.ps1"));
  const powershell = powershellBuffer.toString("utf8");
  const launcher = fs.readFileSync(path.join(repoRoot, "双击我启动审核软件.cmd"), "utf8");

  assert.deepEqual([...powershellBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(powershell, /Get-Command npm\.cmd/);
  assert.doesNotMatch(powershell, /& npm install/);
  assert.match(powershell, /Push-Location \$serverDir/);
  assert.doesNotMatch(powershell, /npmCommand\.Source install[^\n]*--prefix/);
  assert.match(powershell, /nodejs\.org\/dist/);
  assert.match(powershell, /python\.org\/ftp\/python/);
  assert.match(powershell, /REVIEW_OCR_BASE_PYTHON/);
  assert.match(powershell, /System\.Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(powershell, /Get-FileHash/);
  assert.match(powershell, /installerInfo\.Length -lt 10MB/);
  assert.match(powershell, /if \(-not \(Test-PythonRuntime \$pythonExe\)\)/);
  assert.match(powershell, /RedirectStandardError/);
  assert.match(launcher, /if not "%launchExit%"=="0"/);
  assert.match(launcher, /pause/);
});
