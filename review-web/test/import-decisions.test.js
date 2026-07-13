const test = require("node:test");
const assert = require("node:assert/strict");

test("different-person decision keeps roster candidates and adds the PDF person", async () => {
  const { classifyImportDecisions } = await import("../public/import-decisions.js");
  const analysis = {
    rosterNames: ["林小辰", "林小鑫"],
    items: [{ name: "林小晨", matchKind: "ambiguous", excelName: "", matchCandidates: ["林小辰", "林小鑫"] }]
  };
  const result = classifyImportDecisions(analysis, { 林小晨: "__append__" });
  assert.deepEqual(result.onlyExcel, ["林小辰", "林小鑫"]);
  assert.deepEqual(result.onlyPdf.map((item) => item.name), ["林小晨"]);
  assert.deepEqual(result.typos, []);
});

test("selected ambiguous candidate leaves the other roster person unmatched", async () => {
  const { classifyImportDecisions } = await import("../public/import-decisions.js");
  const analysis = {
    rosterNames: ["林小辰", "林小鑫"],
    items: [{ name: "林小晨", matchKind: "ambiguous", excelName: "", matchCandidates: ["林小辰", "林小鑫"] }]
  };
  const result = classifyImportDecisions(analysis, { 林小晨: "excel:林小辰" });
  assert.deepEqual(result.onlyExcel, ["林小鑫"]);
  assert.deepEqual(result.onlyPdf, []);
  assert.equal(result.typos[0].excelName, "林小辰");
});
