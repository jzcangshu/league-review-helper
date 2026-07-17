const assert = require("node:assert/strict");
const test = require("node:test");

test("PDF fit always keeps the complete page visible", async () => {
  const { calculateContainedPdfScale } = await import("../public/pdf-fit.js");
  const scale = calculateContainedPdfScale({
    pageWidth: 595,
    pageHeight: 842,
    containerWidth: 1200,
    containerHeight: 1050,
    padding: 24
  });
  const containScale = Math.min((1200 - 24) / 595, (1050 - 24) / 842);

  assert.equal(scale, containScale);
  assert.ok(595 * scale <= 1200 - 24);
  assert.ok(842 * scale <= 1050 - 24);
});

test("PDF fit handles landscape pages", async () => {
  const { calculateContainedPdfScale } = await import("../public/pdf-fit.js");
  const scale = calculateContainedPdfScale({
    pageWidth: 842,
    pageHeight: 595,
    containerWidth: 1000,
    containerHeight: 760,
    padding: 24
  });
  const containScale = Math.min((1000 - 24) / 842, (760 - 24) / 595);

  assert.equal(scale, containScale);
});

test("PDF fit handles invalid dimensions safely", async () => {
  const { calculateContainedPdfScale } = await import("../public/pdf-fit.js");
  assert.equal(calculateContainedPdfScale({ pageWidth: 0, pageHeight: 842, containerWidth: 1000, containerHeight: 760 }), 1);
});
