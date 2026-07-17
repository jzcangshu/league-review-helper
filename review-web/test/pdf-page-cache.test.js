import assert from "node:assert/strict";
import test from "node:test";

import { createPdfPageCache, pdfPageRenderKey } from "../public/pdf-page-cache.js";

test("PDF page cache keeps recently used pages within a fixed memory bound", () => {
  const cache = createPdfPageCache({ maxEntries: 2 });
  cache.set("1", { page: 1 });
  cache.set("2", { page: 2 });
  assert.equal(cache.get("1").page, 1);
  cache.set("3", { page: 3 });
  assert.equal(cache.get("2"), null);
  assert.equal(cache.get("1").page, 1);
  assert.equal(cache.get("3").page, 3);
  assert.equal(cache.size, 2);
});

test("PDF page cache key separates scale, rotation, document and output density", () => {
  const base = { loadToken: 1, pageNumber: 2, rotation: 0, scale: 1.23456, outputScale: 1.25 };
  assert.equal(pdfPageRenderKey(base), "1:2:0:1.2346:1.25");
  assert.notEqual(pdfPageRenderKey(base), pdfPageRenderKey({ ...base, pageNumber: 3 }));
  assert.notEqual(pdfPageRenderKey(base), pdfPageRenderKey({ ...base, rotation: 90 }));
  assert.notEqual(pdfPageRenderKey(base), pdfPageRenderKey({ ...base, scale: 1.1 }));
});
