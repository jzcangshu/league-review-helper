function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function lineBox(line) {
  const words = line?.words || [];
  if (!words.length) return null;
  const left = Math.min(...words.map((word) => Number(word.x) || 0));
  const top = Math.min(...words.map((word) => Number(word.y) || 0));
  const right = Math.max(...words.map((word) => (Number(word.x) || 0) + (Number(word.width) || 0)));
  const bottom = Math.max(...words.map((word) => (Number(word.y) || 0) + (Number(word.height) || 0)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function substringBox(line, start, end) {
  const box = lineBox(line);
  const length = Math.max(1, String(line.text || "").length);
  if (!box) return null;
  const leftRatio = Math.max(0, start) / length;
  const rightRatio = Math.min(length, Math.max(start + 1, end)) / length;
  return {
    x: box.x + box.width * leftRatio,
    y: box.y,
    width: Math.max(4, box.width * (rightRatio - leftRatio)),
    height: box.height
  };
}

function findPage(pages, keyword, exactLine = false) {
  const target = normalizeText(keyword);
  return pages.find((page) => (page.lines || []).some((line) => {
    const text = normalizeText(line.text);
    return exactLine ? text === target : text.includes(target);
  })) || null;
}

function normalizedDateText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[OoＯ]/g, "0")
    .replace(/[Il|｜]/g, "1");
}

function parseBirthMonthText(value) {
  const text = normalizedDateText(value);
  const patterns = [
    /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/,
    /((?:19|20)\d{2})\s*[.\-/]\s*(\d{1,2})(?:\s*[.\-/月]|\b)/,
    /((?:19|20)\d{2})(0[1-9]|1[0-2])(?:[0-3]\d)?/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    return { year, month, start: match.index, end: match.index + match[0].length };
  }
  return null;
}

function linesInSameRow(page, anchorLine) {
  const anchor = lineBox(anchorLine);
  if (!anchor) return [];
  const anchorCenter = anchor.y + anchor.height / 2;
  const tolerance = Math.max(anchor.height * 0.9, page.height * 0.012);
  return (page.lines || [])
    .map((line) => ({ line, box: lineBox(line) }))
    .filter((entry) => entry.box && Math.abs(entry.box.y + entry.box.height / 2 - anchorCenter) <= tolerance)
    .sort((left, right) => left.box.x - right.box.x);
}

function boxesForCombinedMatch(entries, start, end) {
  const boxes = [];
  let offset = 0;
  for (const entry of entries) {
    const length = String(entry.line.text || "").length;
    const overlapStart = Math.max(start, offset);
    const overlapEnd = Math.min(end, offset + length);
    if (overlapStart < overlapEnd) {
      const box = substringBox(entry.line, overlapStart - offset, overlapEnd - offset);
      if (box) boxes.push(box);
    }
    offset += length;
  }
  return boxes;
}

function extractBirthFromRow(page, headerLine, pageNumber) {
  const entries = linesInSameRow(page, headerLine);
  const text = entries.map((entry) => String(entry.line.text || "")).join("");
  const parsed = parseBirthMonthText(text);
  if (!parsed) return null;
  const boxes = boxesForCombinedMatch(entries, parsed.start, parsed.end);
  if (!boxes.length) return null;
  return { year: parsed.year, month: parsed.month, page: pageNumber, boxes, source: "birth" };
}

function validChineseIdDate(value) {
  const id = normalizedDateText(value).replace(/[^0-9Xx]/g, "").toUpperCase();
  const match = /(\d{17}[0-9X])/.exec(id);
  if (!match) return null;
  const candidate = match[1];
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = "10X98765432";
  const sum = weights.reduce((total, weight, index) => total + Number(candidate[index]) * weight, 0);
  if (checks[sum % 11] !== candidate[17]) return null;
  const year = Number(candidate.slice(6, 10));
  const month = Number(candidate.slice(10, 12));
  const day = Number(candidate.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 || year > 2100 ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function extractBirthFromId(page, pageNumber) {
  const candidates = [];
  const idHeader = (page.lines || []).find((line) => normalizeText(line.text).includes("居民身份证号码"));
  const header = lineBox(idHeader);
  for (const line of page.lines || []) {
    const date = validChineseIdDate(line.text);
    const box = lineBox(line);
    if (!date || !box) continue;
    const distance = header
      ? Math.abs(box.y + box.height / 2 - (header.y + header.height / 2))
      : box.y;
    candidates.push({ ...date, page: pageNumber, boxes: [box], source: "id", distance });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] || null;
}

function birthRowFocus(page, headerLine) {
  const entries = linesInSameRow(page, headerLine);
  const digitEntries = entries.filter((entry) => /\d/.test(normalizedDateText(entry.line.text)));
  const boxes = (digitEntries.length ? digitEntries : entries.filter((entry) => entry.line === headerLine))
    .map((entry) => entry.box)
    .filter(Boolean);
  return boxes.length ? boxes : [lineBox(headerLine)].filter(Boolean);
}

function extractBirthMonth(page, pageNumber) {
  const headerLine = page?.lines?.find((line) => normalizeText(line.text).includes("出生年月"));
  if (!headerLine) return null;
  const direct = extractBirthFromRow(page, headerLine, pageNumber);
  const fromId = extractBirthFromId(page, pageNumber);
  if (direct) return direct;
  if (fromId) return { ...fromId, boxes: birthRowFocus(page, headerLine), idBoxes: fromId.boxes };
  return null;
}

function formatMonth(date) {
  if (!date) return "未识别";
  return `${date.year}年${date.month}月`;
}

function addHighlight(highlights, entry, kind, target) {
  if (!entry?.page || !entry.boxes?.length) return;
  if (!highlights[entry.page]) highlights[entry.page] = [];
  highlights[entry.page].push({
    target,
    score: 1,
    kind,
    boxes: entry.boxes
  });
}

function declarationCount(matches, pageNumber, { minY = -Infinity, maxY = Infinity } = {}) {
  return (matches?.[pageNumber] || []).filter((match) => {
    const target = normalizeText(match.target);
    if (!(target.includes("信仰") || target.includes("宗教") || target === "信仰声明")) return false;
    const boxes = match.boxes || [];
    if (!boxes.length) return minY === -Infinity && maxY === Infinity;
    const centerY = boxes.reduce((sum, box) => sum + box.y + box.height / 2, 0) / boxes.length;
    return centerY >= minY && centerY < maxY;
  }).length;
}

function checkResult(label, status, detail, page, extra = {}) {
  return { label, status, detail, page: page || null, ...extra };
}

function jumpTargets(...targets) {
  return targets.filter((target) => target?.page);
}

function countDistinctRows(entries, pageHeight) {
  const rows = [];
  for (const entry of [...entries].sort((left, right) => left.y - right.y)) {
    if (!rows.some((rowY) => Math.abs(rowY - entry.y) <= pageHeight * 0.025)) rows.push(entry.y);
  }
  return rows.length;
}

function analyzeStudyHours(page) {
  if (!page) return checkResult("团课学时", "pending", "未定位到团课学习记录页", null);
  const titleLine = page.lines.find((line) => normalizeText(line.text).includes("学习记录"));
  const title = lineBox(titleLine);
  const findHeaderBelowTitle = (text) => page.lines
    .filter((line) => normalizeText(line.text) === text && lineBox(line)?.y > (title?.y || -1))
    .sort((left, right) => lineBox(left).y - lineBox(right).y)[0];
  const hourHeaderLine = findHeaderBelowTitle("学时");
  const witnessHeaderLine = findHeaderBelowTitle("证明人");
  const hourHeader = lineBox(hourHeaderLine);
  const witnessHeader = lineBox(witnessHeaderLine);
  if (!hourHeader || !witnessHeader) {
    const focus = title;
    return checkResult("团课学时", "pending", "学时列或证明人列识别不完整", Number(page.page), { focus });
  }

  const belowHeader = (box, header) =>
    box.y > header.y + header.height * 0.6 && box.y < page.height * 0.9;
  const nearColumn = (box, header, ratio) => {
    const center = box.x + box.width / 2;
    const headerCenter = header.x + header.width / 2;
    return Math.abs(center - headerCenter) <= page.width * ratio;
  };
  const hourEntries = [];
  const witnessEntries = [];
  for (const line of page.lines || []) {
    const box = lineBox(line);
    if (!box) continue;
    const text = normalizeText(line.text);
    if (belowHeader(box, hourHeader) && nearColumn(box, hourHeader, 0.075) && /^1(?:h|学时)?$/i.test(text)) {
      hourEntries.push({ ...box, y: box.y });
    }
    if (
      belowHeader(box, witnessHeader) &&
      nearColumn(box, witnessHeader, 0.09) &&
      text !== "证明人" &&
      text.length <= 12 &&
      /\p{Script=Han}/u.test(text)
    ) {
      witnessEntries.push({ ...box, y: box.y });
    }
  }
  const hourCount = countDistinctRows(hourEntries, page.height);
  const witnessCount = countDistinctRows(witnessEntries, page.height);
  const count = Math.max(hourCount, witnessCount);
  const source = witnessCount >= hourCount ? "证明人记录" : "学时记录";
  const detail = `${source} ${count} 条 · 学时“1”识别 ${hourCount} 条`;
  if (count >= 8) {
    return checkResult("团课学时", "pass", `不少于8学时 · ${detail}`, Number(page.page), { focus: hourHeader });
  }
  if (count >= 4) {
    return checkResult("团课学时", "fail", `不足8学时 · ${detail}`, Number(page.page), {
      focus: hourHeader,
      reviewText: "团课学习记录不足8学时"
    });
  }
  return checkResult("团课学时", "pending", `仅可靠识别 ${count} 条记录，请人工确认`, Number(page.page), { focus: hourHeader });
}

function analyzeDisciplineCourse(page) {
  if (!page) return checkResult("团纪处分条例", "pending", "未定位到团课学习记录页", null, { jumpTargets: [] });
  const pageNumber = Number(page.page);
  const titleLine = page.lines.find((line) => normalizeText(line.text).includes("学习记录"));
  const titleFocus = lineBox(titleLine);
  const keywords = ["团纪", "纪律", "处分", "条例"];
  for (const line of page.lines || []) {
    const text = normalizeText(line.text);
    const keyword = keywords.find((candidate) => text.includes(candidate));
    if (!keyword) continue;
    const focus = lineBox(line);
    return checkResult("团纪处分条例", "pass", "已识别到团纪处分条例相关课程", pageNumber, {
      focus,
      jumpTargets: jumpTargets({ label: "团课记录", page: pageNumber, focus })
    });
  }
  return checkResult("团纪处分条例", "fail", "未识别到团纪处分条例相关课程", pageNumber, {
    focus: titleFocus,
    jumpTargets: jumpTargets({ label: "团课记录", page: pageNumber, focus: titleFocus }),
    reviewText: "团课学习记录缺少团纪处分条例学习"
  });
}

export function analyzeOcrReview(ocrData, declarationMatches = {}) {
  const allPages = ocrData?.pages || [];
  const pageObjects = {
    experience: findPage(allPages, "出生年月"),
    study: findPage(allPages, "学习记录"),
    application: findPage(allPages, "入团志愿", true),
    applicationSecond: findPage(allPages, "本人签名"),
    introducer: findPage(allPages, "介绍人签名"),
    secretary: findPage(allPages, "支部书记签名")
  };
  const pages = Object.fromEntries(Object.entries(pageObjects).map(([key, page]) => [key, page ? Number(page.page) : null]));
  const highlights = {};
  const studyTitleLine = pageObjects.study?.lines?.find((line) => normalizeText(line.text).includes("学习记录"));
  const studyFocus = lineBox(studyTitleLine);

  const birthLine = pageObjects.experience?.lines?.find((line) => normalizeText(line.text).includes("出生年月"));
  const birthData = extractBirthMonth(pageObjects.experience, pages.experience);
  let age;
  if (!pageObjects.experience || !birthData) {
    const warning = { page: pages.experience, boxes: [lineBox(birthLine)].filter(Boolean) };
    addHighlight(highlights, warning, "warning", "出生年月识别不完整，请人工确认");
    age = checkResult("年龄门槛", "pending", "出生年月识别不完整，无法计算14周岁月份", pages.experience, {
      focus: warning.boxes[0],
      jumpTargets: jumpTargets(
        { label: "出生年月", page: pages.experience, focus: warning.boxes[0] },
        { label: "团课记录", page: pages.study, focus: studyFocus }
      )
    });
  } else {
    const earliestAllowed = { ...birthData, year: birthData.year + 14 };
    age = checkResult("年龄门槛", "pass", `首次团课不可早于\n${formatMonth(earliestAllowed)}`, pages.experience, {
      focus: birthData.boxes[0],
      jumpTargets: jumpTargets(
        { label: "出生年月", page: pages.experience, focus: birthData.boxes[0] },
        { label: "团课记录", page: pages.study, focus: studyFocus }
      ),
      reviewText: ""
    });
  }

  const studyHours = analyzeStudyHours(pageObjects.study);
  if (studyHours.status === "fail") {
    addHighlight(highlights, { page: studyHours.page, boxes: [studyHours.focus].filter(Boolean) }, "error", "团课学习记录不足8学时");
  } else if (studyHours.status === "pending") {
    addHighlight(highlights, { page: studyHours.page, boxes: [studyHours.focus].filter(Boolean) }, "warning", "团课学时记录需人工确认");
  }
  studyHours.jumpTargets = jumpTargets({ label: "团课记录", page: studyHours.page, focus: studyHours.focus || studyFocus });

  const disciplineCourse = analyzeDisciplineCourse(pageObjects.study);

  const applicationIntroducerSharedPage = pages.applicationSecond && pages.applicationSecond === pages.introducer;
  const applicationSignatureLine = pageObjects.applicationSecond?.lines?.find((line) => normalizeText(line.text).includes("本人签名"));
  const applicationSignatureBox = lineBox(applicationSignatureLine);
  const applicationIntroducerBoundary = applicationIntroducerSharedPage && applicationSignatureBox
    ? applicationSignatureBox.y + applicationSignatureBox.height
    : null;
  const applicationPageNumbers = [...new Set([pages.application, pages.applicationSecond].filter(Boolean))];
  const declarationCounts = {
    application: applicationPageNumbers.reduce((sum, pageNumber) => sum + declarationCount(
      declarationMatches,
      pageNumber,
      pageNumber === pages.applicationSecond && applicationIntroducerBoundary
        ? { maxY: applicationIntroducerBoundary }
        : {}
    ), 0),
    introducer: declarationCount(
      declarationMatches,
      pages.introducer,
      applicationIntroducerBoundary ? { minY: applicationIntroducerBoundary } : {}
    ),
    secretary: declarationCount(declarationMatches, pages.secretary)
  };
  const declarationDetail = `志愿 ${Math.min(declarationCounts.application, 1)}/1 · 介绍人 ${Math.min(declarationCounts.introducer, 2)}/2 · 支部 ${Math.min(declarationCounts.secretary, 1)}/1`;
  const declarationMissingPage = !pageObjects.application || !pageObjects.applicationSecond || !pageObjects.introducer || !pageObjects.secretary;
  const declarationPassed = declarationCounts.application >= 1 && declarationCounts.introducer >= 2 && declarationCounts.secretary >= 1;
  const declarationPage = declarationCounts.application < 1
    ? pages.application || pages.applicationSecond
    : declarationCounts.introducer < 2
      ? pages.introducer
      : pages.secretary;
  const declaration = checkResult(
    "信仰声明",
    declarationMissingPage ? "pending" : declarationPassed ? "pass" : "fail",
    `${declarationPassed ? "数量符合" : "声明缺失"} · ${declarationDetail}`,
    declarationPage,
    { reviewText: declarationPassed || declarationMissingPage ? "" : "入团志愿书信仰声明填写不完整" }
  );

  const secretaryPage = pageObjects.secretary;
  const activistLine = secretaryPage?.lines?.find((line) => normalizeText(line.text).includes("被确定为入团积极分子"));
  let activist;
  if (!secretaryPage) {
    activist = checkResult("积极分子", "pending", "未定位到支部书记签名页", null, {
      jumpTargets: jumpTargets({ label: "团课记录", page: pages.study, focus: studyFocus })
    });
  } else if (!activistLine) {
    activist = checkResult("积极分子", "pass", "未检测到相关表述", pages.secretary, {
      jumpTargets: jumpTargets(
        { label: "支部页面", page: pages.secretary, focus: lineBox(secretaryPage.lines.find((line) => normalizeText(line.text).includes("支部书记签名"))) },
        { label: "团课记录", page: pages.study, focus: studyFocus }
      )
    });
  } else {
    const activistEntry = {
      page: pages.secretary,
      boxes: [lineBox(activistLine)].filter(Boolean)
    };
    addHighlight(highlights, activistEntry, "warning", "检测到入团积极分子表述，请人工核对");
    activist = checkResult("积极分子", "pending", "请确保确认积极分子/递交入团申请时间早于首次团课", pages.secretary, {
      focus: activistEntry.boxes[0],
      jumpTargets: jumpTargets(
        { label: "积极分子", page: pages.secretary, focus: activistEntry.boxes[0] },
        { label: "团课记录", page: pages.study, focus: studyFocus }
      ),
      reviewText: ""
    });
  }

  return {
    pages,
    checks: { age, studyHours, disciplineCourse, declaration, activist },
    highlights,
    progress: 100
  };
}
