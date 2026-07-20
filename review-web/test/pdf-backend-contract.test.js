const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const scriptsDir = path.join(__dirname, "..", "scripts");

test("offline PDF rendering uses the redistributable PDFium backend", () => {
  for (const name of ["ocr-pdf-v6.py", "render-pdf-thumbnails.py"]) {
    const source = fs.readFileSync(path.join(scriptsDir, name), "utf8");
    assert.match(source, /import pypdfium2 as pdfium/);
    assert.doesNotMatch(source, /import fitz/);
  }
});
