const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { configuredRuntimePython } = require("../lib/ocr-service");
const { pythonRuntimeCandidates } = require("../lib/thumbnail-service");

test("packaged OCR Python path is resolved from the explicit environment", () => {
  const expected = path.resolve("runtime", "python", "python.exe");
  assert.equal(configuredRuntimePython({ REVIEW_OCR_RUNTIME_PYTHON: expected }), expected);
  assert.equal(configuredRuntimePython({ REVIEW_OCR_RUNTIME_PYTHON: "  " }), null);
});

test("thumbnail rendering prefers packaged Python over the legacy virtual environment", () => {
  const packaged = path.resolve("runtime", "python", "python.exe");
  const legacyRoot = path.resolve("review-web", ".ocr-python");
  assert.deepEqual(
    pythonRuntimeCandidates({ runtimeRoot: legacyRoot }, { REVIEW_OCR_RUNTIME_PYTHON: packaged }),
    [packaged, path.join(legacyRoot, "Scripts", "python.exe")]
  );
});
