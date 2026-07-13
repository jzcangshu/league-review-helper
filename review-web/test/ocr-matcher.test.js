const test = require("node:test");
const assert = require("node:assert/strict");

test("fuzzy OCR matching tolerates a small recognition error", async () => {
  const { fuzzyTextScore, findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const close = fuzzyTextScore("马克思列宁主义", "马克思列宇主义");
  assert.ok(close.score > 0.7);

  const page = {
    page: 1,
    width: 1000,
    height: 1400,
    lines: [{
      text: "马克思列宇主义",
      words: [
        { text: "马克思", x: 100, y: 200, width: 120, height: 40 },
        { text: "列宇主义", x: 230, y: 200, width: 160, height: 40 }
      ]
    }]
  };
  const matches = findOcrTargetMatches(page, [{ label: "马克思列宁主义", phrases: ["马克思列宁主义"] }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 1);
  assert.deepEqual(matches[0].boxes[0], { x: 100, y: 200, width: 290, height: 40 });
});

test("long declaration can match by a recognized clause", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 1,
    width: 1000,
    height: 1400,
    lines: [{
      text: "未参加任何宗教活劝",
      words: [{ text: "未参加任何宗教活劝", x: 80, y: 500, width: 500, height: 50 }]
    }]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
    phrases: ["只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动", "未参加任何宗教活动"]
  }]);
  assert.equal(matches.length, 1);
});

test("a phrase inside one OCR line only highlights its proportional character range", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 9,
    width: 1400,
    height: 2000,
    lines: [{
      text: "杜婉宁信仰马克思主义无其他宗教信仰",
      words: [{ text: "杜婉宁信仰马克思主义无其他宗教信仰", x: 100, y: 600, width: 900, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "信仰说明",
    phrases: ["信仰马克思主义无其他宗教信仰"]
  }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 1);
  assert.ok(matches[0].boxes[0].x > 100);
  assert.ok(matches[0].boxes[0].width < 900);
});

test("a phrase spanning OCR lines returns precise pieces instead of whole lines", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 9,
    width: 1400,
    height: 2000,
    lines: [
      { text: "姓名只信仰马克思主义", words: [{ text: "姓名只信仰马克思主义", x: 100, y: 600, width: 800, height: 60 }] },
      { text: "无其他宗教信仰后续文字", words: [{ text: "无其他宗教信仰后续文字", x: 100, y: 680, width: 800, height: 60 }] }
    ]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "信仰说明",
    phrases: ["只信仰马克思主义无其他宗教信仰"]
  }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 2);
  assert.ok(matches[0].boxes[0].x > 100);
  assert.ok(matches[0].boxes[1].width < 800);
});

test("OCR boxes follow PDF rotation and viewport size", async () => {
  const { transformOcrBox } = await import("../public/ocr-matcher.js");
  const box = { x: 100, y: 200, width: 300, height: 100 };
  assert.deepEqual(transformOcrBox(box, 1000, 2000, 500, 1000, 0), {
    left: 50, top: 100, width: 150, height: 50
  });
  assert.deepEqual(transformOcrBox(box, 1000, 2000, 1000, 500, 90), {
    left: 850, top: 50, width: 50, height: 150
  });
});

test("recall mode groups nearby short fragments", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1000,
    height: 1400,
    lines: [
      { text: "只信仰马可思", words: [{ text: "只信仰马可思", x: 100, y: 300, width: 300, height: 45 }] },
      { text: "无其他宗教", words: [{ text: "无其他宗教", x: 110, y: 390, width: 280, height: 45 }] }
    ]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "宗教信仰长句",
    phrases: [],
    fragments: ["只信仰", "马克思", "无其他", "宗教"]
  }]);
  assert.ok(matches.some((match) => match.approximate && match.fragmentCount >= 2));
});

test("an exact clause is not merged with nearby approximate fragments", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 9,
    width: 1488,
    height: 2105,
    lines: [
      { text: "婉宁积极参加志愿实践活动努力完善自己", words: [{ text: "婉宁积极参加志愿实践活动努力完善自己", x: 352, y: 513, width: 879, height: 51 }] },
      { text: "认为其已经具备了团员条件", words: [{ text: "认为其已经具备了团员条件", x: 365, y: 570, width: 366, height: 51 }] },
      { text: "杜女婉宁信仰与克思主义无其它宗教信仰未参加任何宗教活动", words: [{ text: "杜女婉宁信仰与克思主义无其它宗教信仰未参加任何宗教活动", x: 410, y: 627, width: 843, height: 51 }] }
    ]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "宗教信仰长句",
    phrases: ["未参加任何宗教活动"],
    fragments: ["只信仰", "马克思主义", "无其他", "其他宗教", "宗教信仰", "未参加", "任何宗教", "宗教活动"],
    minimumFragments: 2
  }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 1);
  assert.ok(matches[0].boxes[0].y >= 600);
  assert.ok(matches[0].boxes[0].x >= 500);
  assert.ok(matches[0].boxes[0].width < 780);
});

test("two separated occurrences of the declaration are both highlighted", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 8,
    width: 1488,
    height: 2105,
    lines: [
      { text: "信仰上杜婉宁信仰马克思主义无其它宗", words: [{ text: "信仰上杜婉宁信仰马克思主义无其它宗", x: 325, y: 504, width: 924, height: 71 }] },
      { text: "教信仰未参加任何宗教活动", words: [{ text: "教信仰未参加任何宗教活动", x: 332, y: 581, width: 611, height: 68 }] },
      { text: "行动上踏实学习信仰上杜婉宁信仰马克思主义无其它宗教信仰未参加任", words: [{ text: "行动上踏实学习信仰上杜婉宁信仰马克思主义无其它宗教信仰未参加任", x: 305, y: 1361, width: 953, height: 76 }] },
      { text: "何宗教活动", words: [{ text: "何宗教活动", x: 312, y: 1429, width: 251, height: 56 }] }
    ]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
    phrases: [
      "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
      "只信仰马克思主义",
      "无其他宗教信仰",
      "未参加任何宗教活动"
    ],
    fragments: ["马克思主义", "宗教信仰", "任何宗教", "宗教活动"]
  }]);
  assert.equal(matches.length, 2);
  assert.ok(Math.min(...matches[0].boxes.map((box) => box.y)) < 700);
  assert.ok(Math.min(...matches[1].boxes.map((box) => box.y)) > 1200);
});

test("specific terms require their distinctive anchor", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1000,
    height: 1400,
    lines: [{
      text: "学习中国特色社会主义进入新的时代",
      words: [{ text: "学习中国特色社会主义进入新的时代", x: 100, y: 300, width: 700, height: 45 }]
    }]
  };
  const matches = findOcrTargetMatches(page, [{
    label: "习近平新时代中国特色社会主义",
    phrases: [],
    fragments: ["习近平", "新时代", "中国特色社会主义"],
    requiredAny: ["习近平"]
  }]);
  assert.deepEqual(matches, []);
});

test("series ideologies are highlighted as one continuous multi-line block", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 2000,
    height: 2800,
    lines: [
      {
        text: "我的思想来源于政治理论中的马克恩列宁义、毛泽未思想，邓小平理论",
        words: [{ text: "我的思想来源于政治理论中的马克恩列宁义、毛泽未思想，邓小平理论", x: 300, y: 1200, width: 1400, height: 160 }]
      },
      {
        text: "三个代表，科学发展观和习近平新时代中国特色社会议理论，这些理论指引方向",
        words: [{ text: "三个代表，科学发展观和习近平新时代中国特色社会议理论，这些理论指引方向", x: 280, y: 1280, width: 1500, height: 170 }]
      }
    ]
  };
  const matches = findOcrTargetMatches(page).filter((match) => match.target === "系列思想");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 2);
  assert.deepEqual(matches[0].boxes.map((box) => box.y), [1200, 1280]);
  assert.ok(matches[0].boxes.every((box) => box.height <= 70));
});

test("scattered generic ideology words do not produce highlights", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2200,
    lines: [
      { text: "端正自己的思想", words: [{ text: "端正自己的思想", x: 200, y: 300, width: 400, height: 50 }] },
      { text: "学习科学文化知识", words: [{ text: "学习科学文化知识", x: 200, y: 900, width: 500, height: 50 }] },
      { text: "争做新时代青年", words: [{ text: "争做新时代青年", x: 200, y: 1600, width: 500, height: 50 }] }
    ]
  };
  const matches = findOcrTargetMatches(page).filter((match) => match.target === "系列思想");
  assert.deepEqual(matches, []);
});

test("series ideology boxes are cropped to the first and last anchors", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1600,
    height: 2200,
    lines: [{
      text: "前面的普通说明文字马克思列宁主义、毛泽东思想、邓小平理论后面的普通说明文字",
      words: [{ text: "前面的普通说明文字马克思列宁主义、毛泽东思想、邓小平理论后面的普通说明文字", x: 100, y: 700, width: 1400, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page).filter((match) => match.target === "系列思想");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].boxes.length, 1);
  assert.ok(matches[0].boxes[0].x > 100);
  assert.ok(matches[0].boxes[0].width < 1000);
});

test("default faith declaration matching keeps its precise clause behavior", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "姓名只信仰马克思主义无其他宗教信仰未参加任何宗教活动后续文字",
      words: [{ text: "姓名只信仰马克思主义无其他宗教信仰未参加任何宗教活动后续文字", x: 100, y: 500, width: 1100, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page);
  const declaration = matches.find((match) => match.target.includes("只信仰马克思主义"));
  assert.ok(declaration);
  assert.equal(declaration.boxes.length, 1);
  assert.ok(declaration.boxes[0].x > 100);
  assert.ok(declaration.boxes[0].width < 1100);
});

test("faith declaration falls back to a fuzzy no-religion phrase", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "本人不存在忠教信昂并自觉遵守组织要求",
      words: [{ text: "本人不存在忠教信昂并自觉遵守组织要求", x: 100, y: 500, width: 1000, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page);
  const declaration = matches.find((match) => match.target.includes("只信仰马克思主义"));
  assert.ok(declaration);
  assert.equal(declaration.faithFallback, true);
  assert.ok(declaration.boxes[0].x > 150);
  assert.ok(declaration.boxes[0].width < 600);
});

test("faith declaration fallback allows missing characters", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "本人不存宗教信仰并自觉遵守组织要求",
      words: [{ text: "本人不存宗教信仰并自觉遵守组织要求", x: 100, y: 500, width: 950, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page);
  const declaration = matches.find((match) => match.target.includes("只信仰马克思主义"));
  assert.ok(declaration);
});

test("faith declaration accepts the common 宗教感情 OCR confusion", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "本人不存在宗教感情并积极参加集体活动",
      words: [{ text: "本人不存在宗教感情并积极参加集体活动", x: 100, y: 500, width: 980, height: 60 }]
    }]
  };
  const matches = findOcrTargetMatches(page);
  const declaration = matches.find((match) => match.target.includes("只信仰马克思主义"));
  assert.ok(declaration);
  assert.equal(declaration.faithFallback, true);
  assert.equal(declaration.phrase, "宗教感情");
});

test("faith declaration fuzzy anchors tolerate one typo or missing character", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const cases = [
    "声明内容为宗教感青",
    "声明内容为宗教感",
    "声明内容为宗教活幼",
    "声明内容为宗教活"
  ];
  for (const text of cases) {
    const page = {
      page: 6,
      width: 1400,
      height: 2000,
      lines: [{ text, words: [{ text, x: 100, y: 500, width: 1000, height: 60 }] }]
    };
    const declaration = findOcrTargetMatches(page)
      .find((match) => match.target.includes("只信仰马克思主义"));
    assert.ok(declaration, text);
    assert.ok(declaration.boxes[0].width < 600, text);
  }
});

test("faith declaration fuzzy anchors do not accept a generic religious phrase", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const text = "学校近期调整宗教安排并开展常规教育";
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{ text, words: [{ text, x: 100, y: 500, width: 1000, height: 60 }] }]
  };
  const declarations = findOcrTargetMatches(page)
    .filter((match) => match.target.includes("只信仰马克思主义"));
  assert.deepEqual(declarations, []);
});

test("faith declaration fallback keeps two separated occurrences", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 8,
    width: 1400,
    height: 2000,
    lines: [
      { text: "该同学不存在宗教感情", words: [{ text: "该同学不存在宗教感情", x: 100, y: 450, width: 600, height: 60 }] },
      { text: "该同学不存宗教信昂", words: [{ text: "该同学不存宗教信昂", x: 100, y: 1350, width: 600, height: 60 }] }
    ]
  };
  const declarations = findOcrTargetMatches(page)
    .filter((match) => match.target.includes("只信仰马克思主义"));
  assert.equal(declarations.length, 2);
  assert.ok(Math.min(...declarations[0].boxes.map((box) => box.y)) < 700);
  assert.ok(Math.min(...declarations[1].boxes.map((box) => box.y)) > 1200);
});

test("faith declaration fallback does not duplicate an existing precise match", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "姓名只信仰马克思主义无其他宗教信仰未参加任何宗教活动",
      words: [{ text: "姓名只信仰马克思主义无其他宗教信仰未参加任何宗教活动", x: 100, y: 500, width: 1100, height: 60 }]
    }]
  };
  const declarations = findOcrTargetMatches(page)
    .filter((match) => match.target.includes("只信仰马克思主义"));
  assert.equal(declarations.length, 1);
  assert.notEqual(declarations[0].faithFallback, true);
});

test("faith declaration accepts religious activity text on its own", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "学校不存在宗教活动安排并定期开展纪律教育",
      words: [{ text: "学校不存在宗教活动安排并定期开展纪律教育", x: 100, y: 500, width: 1050, height: 60 }]
    }]
  };
  const declarations = findOcrTargetMatches(page)
    .filter((match) => match.target.includes("只信仰马克思主义"));
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].phrase, "宗教活动");
});

test("faith declaration does not accept Marxism on its own", async () => {
  const { findOcrTargetMatches } = await import("../public/ocr-matcher.js");
  const page = {
    page: 6,
    width: 1400,
    height: 2000,
    lines: [{
      text: "本人认真学习马克思主义理论并积极参加集体活动",
      words: [{ text: "本人认真学习马克思主义理论并积极参加集体活动", x: 100, y: 500, width: 1050, height: 60 }]
    }]
  };
  const declarations = findOcrTargetMatches(page)
    .filter((match) => match.target.includes("只信仰马克思主义"));
  assert.deepEqual(declarations, []);
});

test("document matching uses exact page keywords instead of fixed page offsets", async () => {
  const { findDocumentOcrMatches } = await import("../public/ocr-matcher.js");
  const page = (pageNumber, texts) => ({
    page: pageNumber,
    width: 1000,
    height: 1400,
    lines: (Array.isArray(texts) ? texts : [texts]).map((text, index) => ({
      text,
      words: [{ text, x: 50, y: 80 + index * 70, width: 300, height: 40 }]
    }))
  });
  const matches = findDocumentOcrMatches({ pages: [
    page(6, ["入团志愿", "马克思列宁主义"]),
    page(7, "马克思列宁主义"),
    page(15, ["本人签名", "马克思列宁主义"]),
    page(22, ["介绍人签名", "马克思列宁主义"]),
    page(30, ["支部书记签名", "马克思列宁主义"])
  ] }, [{ label: "马克思列宁主义", phrases: ["马克思列宁主义"], fragments: ["马克思", "列宁"] }]);
  assert.equal(matches[6][0].target, "马克思列宁主义");
  assert.deepEqual(matches[7], []);
  assert.equal(matches[15][0].target, "马克思列宁主义");
  assert.equal(matches[22][0].target, "马克思列宁主义");
  assert.equal(matches[30][0].target, "马克思列宁主义");
});
