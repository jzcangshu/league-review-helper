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

test("document matching searches likely form pages without drawing section fallbacks", async () => {
  const { findDocumentOcrMatches } = await import("../public/ocr-matcher.js");
  const page = (pageNumber, text) => ({
    page: pageNumber,
    width: 1000,
    height: 1400,
    lines: [{ text, words: [{ text, x: 50, y: 80, width: 300, height: 40 }] }]
  });
  const matches = findDocumentOcrMatches({ pages: [
    page(6, "入团志愿"),
    page(7, "马克思列宁主义"),
    page(8, "姓名 联系电话 单位"),
    page(9, "会议认为"),
    page(10, "备注"),
    page(11, "说明 马克思列宁主义")
  ] }, [{ label: "马克思列宁主义", phrases: ["马克思列宁主义"], fragments: ["马克思", "列宁"] }]);
  assert.equal(matches[6].length, 0);
  assert.equal(matches[7][0].target, "马克思列宁主义");
  assert.equal(matches[8].length, 0);
  assert.equal(matches[9].length, 0);
  assert.equal(matches[10].length, 0);
  assert.deepEqual(matches[11], []);
});
