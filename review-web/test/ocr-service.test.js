const test = require("node:test");
const assert = require("node:assert/strict");

const { parseOcrOutput } = require("../lib/ocr-service");

test("parses UTF-8 Windows OCR output", () => {
  const parsed = parseOcrOutput('\uFEFF{"engine":"windows-ocr","pages":[]}\r\n');
  assert.equal(parsed.engine, "windows-ocr");
  assert.deepEqual(parsed.pages, []);
});
