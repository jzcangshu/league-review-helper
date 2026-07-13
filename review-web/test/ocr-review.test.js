const test = require("node:test");
const assert = require("node:assert/strict");

function line(text, x, y, width = 520, height = 42, confidence = 0.95) {
  return {
    text,
    confidence,
    words: [{ text, x, y, width, height }]
  };
}

function page(pageNumber, lines) {
  return { page: pageNumber, width: 1200, height: 1800, lines };
}

test("review analysis locates pages by exact keywords instead of page numbers", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const ocrData = { pages: [
    page(12, [line("出生年月2010年12月", 120, 180)]),
    page(3, [line("团课学习记录", 420, 80), line("2025年12月6日", 120, 280)]),
    page(15, [line("入团志愿", 420, 80)]),
    page(6, [line("本人签名：张三", 500, 1500), line("2025年12月20日", 780, 1560)]),
    page(9, [line("介绍人签名：甲", 300, 700), line("2025年12月21日", 760, 700)]),
    page(18, [
      line("支部书记签名：乙", 300, 900),
      line("2025年12月22日", 760, 900),
      line("入团时间从2025年12月22日算起", 300, 1200)
    ])
  ] };
  const declarationMatches = {
    15: [{ target: "信仰声明", boxes: [{ x: 300, y: 500, width: 500, height: 50 }] }],
    9: [
      { target: "信仰声明", boxes: [{ x: 300, y: 400, width: 500, height: 50 }] },
      { target: "信仰声明", boxes: [{ x: 300, y: 1100, width: 500, height: 50 }] }
    ],
    18: [{ target: "信仰声明", boxes: [{ x: 300, y: 500, width: 500, height: 50 }] }]
  };
  const result = analyzeOcrReview(ocrData, declarationMatches);
  assert.deepEqual(result.pages, {
    experience: 12,
    study: 3,
    application: 15,
    applicationSecond: 6,
    introducer: 9,
    secretary: 18
  });
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.declaration.status, "pass");
  assert.equal(result.checks.joinDate.status, "pass");
});

test("review analysis flags age, order, declaration count, and join-date mismatch", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const ocrData = { pages: [
    page(2, [line("出生年月2012年8月", 120, 180)]),
    page(4, [line("团课学习记录", 420, 80), line("2026年7月1日", 120, 280)]),
    page(5, [line("入团志愿", 420, 80)]),
    page(7, [line("本人签名：张三", 500, 1450), line("2026年6月30日", 780, 1500)]),
    page(10, [
      line("介绍人签名：甲", 300, 600),
      line("2026年7月2日", 760, 600),
      line("介绍人签名：乙", 300, 1300),
      line("2026年7月3日", 760, 1300)
    ]),
    page(13, [
      line("2026年6月被确定为入团积极分子", 300, 300),
      line("支部书记签名：丙", 300, 900),
      line("2026年7月4日", 760, 900),
      line("入团时间从2026年7月5日算起", 300, 1200),
      line("2026年7月5日", 850, 1650)
    ])
  ] };
  const declarationMatches = {
    5: [{ target: "信仰声明", boxes: [{ x: 300, y: 500, width: 500, height: 50 }] }],
    10: [{ target: "信仰声明", boxes: [{ x: 300, y: 400, width: 500, height: 50 }] }]
  };
  const result = analyzeOcrReview(ocrData, declarationMatches);
  assert.equal(result.checks.age.status, "fail");
  assert.equal(result.checks.dateOrder.status, "fail");
  assert.equal(result.checks.dateOrder.issueCount, 2);
  assert.equal(result.checks.declaration.status, "fail");
  assert.equal(result.checks.declaration.detail, "志愿 1/1 · 介绍人 1/2 · 支部 0/1");
  assert.equal(result.checks.joinDate.status, "fail");
  assert.equal(result.checks.activist.status, "pass");
  assert.ok(result.highlights[7].some((entry) => entry.kind === "error"));
  assert.ok(result.highlights[13].some((entry) => entry.kind === "notice"));
  assert.ok(result.highlights[13].every((entry) => entry.boxes[0].y < 1500));
});

test("incomplete dates remain pending instead of being treated as compliant", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const ocrData = { pages: [
    page(1, [line("出生年月2011年12月", 120, 180)]),
    page(2, [line("团课学习记录", 420, 80), line("2026年月6日", 120, 280)]),
    page(3, [line("本人签名", 500, 1500)]),
    page(4, [line("介绍人签名", 300, 700)]),
    page(5, [line("支部书记签名", 300, 900)])
  ] };
  const result = analyzeOcrReview(ocrData, {});
  assert.equal(result.checks.age.status, "pending");
  assert.equal(result.checks.dateOrder.status, "pending");
  assert.equal(result.checks.joinDate.status, "pending");
});
