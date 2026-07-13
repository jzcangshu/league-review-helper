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

function chineseIdForDate(date, sequence = "001") {
  const first17 = `110105${date}${sequence}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const sum = [...first17].reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return `${first17}${checks[sum % 11]}`;
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
});

test("birth month is read from a separate OCR line in the same table row", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const result = analyzeOcrReview({ pages: [page(3, [
    line("民族", 120, 300, 120, 50),
    line("汉族", 300, 304, 120, 50),
    line("出生年月", 560, 302, 180, 50),
    line("2011年9月", 780, 305, 190, 50)
  ])] }, {});
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.age.detail, "首次团课不可早于\n2025年9月");
});

test("a valid Chinese ID restores a birth month when OCR drops a year digit", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const id = chineseIdForDate("20110707");
  const result = analyzeOcrReview({ pages: [page(3, [
    line("出生年月201年7月7日", 560, 300, 420, 60),
    line("居民身份证号码", 220, 620, 260, 50),
    line(id, 540, 620, 420, 50)
  ])] }, {});
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.age.detail, "首次团课不可早于\n2025年7月");
});

test("an invalid ID cannot turn an incomplete birth date into a pass", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const validId = chineseIdForDate("20110707");
  const invalidId = `${validId.slice(0, -1)}${validId.endsWith("0") ? "1" : "0"}`;
  const result = analyzeOcrReview({ pages: [page(3, [
    line("出生年月201年7月7日", 560, 300, 420, 60),
    line("居民身份证号码", 220, 620, 260, 50),
    line(invalidId, 540, 620, 420, 50)
  ])] }, {});
  assert.equal(result.checks.age.status, "pending");
});

test("a complete birth field takes priority over a different valid ID date", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const result = analyzeOcrReview({ pages: [page(3, [
    line("出生年月2011年8月", 560, 300, 420, 60),
    line("居民身份证号码", 220, 620, 260, 50),
    line(chineseIdForDate("20110707"), 540, 620, 420, 50)
  ])] }, {});
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.age.detail, "首次团课不可早于\n2025年8月");
});

test("introducer declarations on a merged page do not satisfy the application declaration", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const ocrData = { pages: [
    page(3, [line("入团志愿", 420, 80), line("无法辨认的志愿正文", 180, 500)]),
    page(4, [
      line("本人签名：陈馨", 700, 650),
      line("姓名：介绍人甲", 200, 900),
      line("介绍人签名：甲", 700, 1250),
      line("姓名：介绍人乙", 200, 1400),
      line("介绍人签名：乙", 700, 1700)
    ]),
    page(5, [line("支部书记签名：丙", 700, 1100)])
  ] };
  const declarationMatches = {
    4: [
      { target: "信仰声明", boxes: [{ x: 240, y: 980, width: 600, height: 50 }] },
      { target: "信仰声明", boxes: [{ x: 240, y: 1480, width: 600, height: 50 }] }
    ],
    5: [{ target: "信仰声明", boxes: [{ x: 240, y: 700, width: 600, height: 50 }] }]
  };
  const result = analyzeOcrReview(ocrData, declarationMatches);
  assert.equal(result.checks.declaration.status, "fail");
  assert.equal(result.checks.declaration.detail, "声明缺失 · 志愿 0/1 · 介绍人 2/2 · 支部 1/1");
});

test("review analysis keeps activist dates as a manual text reminder", async () => {
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
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.age.detail, "首次团课不可早于\n2026年8月");
  assert.deepEqual(result.checks.age.jumpTargets.map((target) => [target.label, target.page]), [
    ["出生年月", 2],
    ["团课记录", 4]
  ]);
  assert.equal(result.checks.declaration.status, "fail");
  assert.equal(result.checks.declaration.detail, "声明缺失 · 志愿 1/1 · 介绍人 1/2 · 支部 0/1");
  assert.equal(result.checks.activist.status, "pending");
  assert.equal(result.checks.activist.detail, "请确保确认积极分子/递交入团申请时间早于首次团课");
  assert.deepEqual(result.checks.activist.jumpTargets.map((target) => [target.label, target.page]), [
    ["积极分子", 13],
    ["团课记录", 4]
  ]);
  assert.ok(result.highlights[13].some((entry) => entry.kind === "warning"));
});

test("non-birth dates do not create automatic date judgments", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const ocrData = { pages: [
    page(1, [line("出生年月2011年12月", 120, 180)]),
    page(2, [line("团课学习记录", 420, 80), line("2026年月6日", 120, 280)]),
    page(3, [line("本人签名", 500, 1500)]),
    page(4, [line("介绍人签名", 300, 700)]),
    page(5, [line("支部书记签名", 300, 900)])
  ] };
  const result = analyzeOcrReview(ocrData, {});
  assert.equal(result.checks.age.status, "pass");
  assert.equal(result.checks.age.detail, "首次团课不可早于\n2025年12月");
  assert.equal(result.checks.dateOrder, undefined);
  assert.equal(result.checks.joinDate, undefined);
  assert.ok(result.highlights[2].some((entry) => entry.kind === "warning"));
});

test("study hours prefer proof-column row count over inconsistent hour text", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const rows = Array.from({ length: 8 }, (_, index) => {
    const y = 320 + index * 140;
    return [
      line(index < 2 ? "1h" : index === 2 ? "1" : "i", 720, y, 70, 42),
      line(["张老师", "章老师", "张老帅", "张老师", "张老师", "章老师", "张老师", "张老师"][index], 930, y, 130, 42)
    ];
  }).flat();
  const result = analyzeOcrReview({ pages: [page(4, [
    line("团课学习记录", 420, 80, 300, 42),
    line("学时", 710, 200, 100, 42),
    line("证明人", 920, 200, 140, 42),
    ...rows
  ])] }, {});
  assert.equal(result.checks.studyHours.status, "pass");
  assert.match(result.checks.studyHours.detail, /证明人记录 8 条/);
  assert.match(result.checks.studyHours.detail, /学时“1”识别 3 条/);
});

test("study hours below eight provide a review phrase and red target", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const rows = Array.from({ length: 7 }, (_, index) => {
    const y = 320 + index * 140;
    return [line("1学时", 720, y, 80, 42), line("李老师", 930, y, 130, 42)];
  }).flat();
  const result = analyzeOcrReview({ pages: [page(4, [
    line("团课学习记录", 420, 80, 300, 42),
    line("学时", 710, 200, 100, 42),
    line("证明人", 920, 200, 140, 42),
    ...rows
  ])] }, {});
  assert.equal(result.checks.studyHours.status, "fail");
  assert.equal(result.checks.studyHours.reviewText, "团课学习记录不足8学时");
  assert.ok(result.highlights[4].some((entry) => entry.kind === "error"));
});

test("discipline course passes when any suggested keyword is present", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  for (const keyword of ["团纪", "纪律", "处分", "条例"]) {
    const result = analyzeOcrReview({ pages: [page(4, [
      line("团课学习记录", 420, 80, 300, 42),
      line(`中国共产主义青年团${keyword}专题学习`, 160, 520, 760, 42)
    ])] }, {});
    assert.equal(result.checks.disciplineCourse.status, "pass");
    assert.equal(result.checks.disciplineCourse.detail, "已识别到团纪处分条例相关课程");
    assert.equal(result.checks.disciplineCourse.page, 4);
  }
});

test("missing discipline course provides a review phrase and study-page jump", async () => {
  const { analyzeOcrReview } = await import("../public/ocr-review.js");
  const result = analyzeOcrReview({ pages: [page(4, [
    line("团课学习记录", 420, 80, 300, 42),
    line("团章和团史专题学习", 160, 520, 760, 42)
  ])] }, {});
  assert.equal(result.checks.disciplineCourse.status, "fail");
  assert.equal(result.checks.disciplineCourse.reviewText, "团课学习记录缺少团纪处分条例学习");
  assert.deepEqual(result.checks.disciplineCourse.jumpTargets.map((target) => [target.label, target.page]), [
    ["团课记录", 4]
  ]);
});
