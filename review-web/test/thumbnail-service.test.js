const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { generatePdfThumbnails } = require("../lib/thumbnail-service");

test("thumbnail service generates once and reuses its disk cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "league-review-thumbnails-"));
  const pdfPath = path.join(root, "student.pdf");
  const cacheRoot = path.join(root, "cache");
  await fs.writeFile(pdfPath, "fixture", "utf8");
  let renderCount = 0;
  const renderer = async ({ cacheDir }) => {
    renderCount += 1;
    await fs.writeFile(path.join(cacheDir, "1.png"), "png", "utf8");
    await fs.writeFile(path.join(cacheDir, "2.png"), "png", "utf8");
    return { pages: [
      { page: 1, width: 120, height: 160, fileName: "1.png" },
      { page: 2, width: 120, height: 160, fileName: "2.png" }
    ] };
  };

  const first = await generatePdfThumbnails({ pdfPath, cacheRoot, renderer });
  const second = await generatePdfThumbnails({ pdfPath, cacheRoot, renderer });

  assert.equal(renderCount, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.pages.map((page) => page.page), [1, 2]);
});
