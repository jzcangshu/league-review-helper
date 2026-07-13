function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function lineBox(line) {
  const words = line.words || [];
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

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : Math.min(diagonal, above, row[rightIndex - 1]) + 1;
      diagonal = above;
    }
  }
  return row[right.length];
}

function normalizeYear(rawYear, dominantYear) {
  const raw = String(rawYear || "");
  const numeric = Number(raw);
  if (raw.length === 4 && numeric >= 2000 && numeric <= 2099) {
    if (dominantYear && Math.abs(numeric - dominantYear) > 10 && editDistance(raw, String(dominantYear)) <= 1) {
      return { year: dominantYear, inferred: true };
    }
    return { year: numeric, inferred: false };
  }
  if (dominantYear && editDistance(raw, String(dominantYear)) <= 1) {
    return { year: dominantYear, inferred: true };
  }
  return { year: null, inferred: false };
}

function dominantDocumentYear(pages, excludedPage) {
  const counts = new Map();
  for (const page of pages) {
    if (page === excludedPage) continue;
    for (const line of page.lines || []) {
      for (const match of String(line.text || "").matchAll(/20\d{2}/g)) {
        const year = Number(match[0]);
        counts.set(year, (counts.get(year) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function extractDates(page, dominantYear) {
  const dates = [];
  const incompleteLines = [];
  for (const line of page?.lines || []) {
    const text = String(line.text || "")
      .replace(/[OoＯ]/g, "0")
      .replace(/[Il|｜]/g, "1");
    const spans = [];
    const lineDateStart = dates.length;
    const patterns = [
      { regex: /(\d{3,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日月]?/g, precision: "day" },
      { regex: /(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/g, precision: "day" },
      { regex: /(\d{3,4})\s*年\s*(\d{1,2})\s*月/g, precision: "month" }
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern.regex)) {
        const start = match.index || 0;
        const end = start + match[0].length;
        if (spans.some((span) => start >= span.start && end <= span.end)) continue;
        const normalizedYear = normalizeYear(match[1], dominantYear);
        const month = Number(match[2]);
        const day = pattern.precision === "day" ? Number(match[3]) : null;
        if (!normalizedYear.year || month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) continue;
        const box = substringBox(line, start, end);
        if (!box) continue;
        const confidence = Number(line.confidence) || 0;
        const suspiciousDayDelimiter = pattern.precision === "day" && /^[^\p{L}\p{N}\s]{1,2}日/u.test(text.slice(end, end + 3));
        spans.push({ start, end });
        dates.push({
          year: normalizedYear.year,
          month,
          day,
          precision: pattern.precision,
          inferred: normalizedYear.inferred,
          uncertain: confidence < 0.82 || suspiciousDayDelimiter,
          page: Number(page.page),
          x: box.x,
          y: box.y,
          boxes: [box],
          text: match[0],
          lineText: String(line.text || ""),
          confidence
        });
      }
    }
    const lineDates = dates.slice(lineDateStart);
    const missingDay = /日/.test(text) && lineDates.length && lineDates.every((date) => date.precision !== "day");
    if (/年/.test(text) && /月|日/.test(text) && (!spans.length || missingDay)) {
      const box = lineBox(line);
      if (box) incompleteLines.push({ page: Number(page.page), boxes: [box], text: line.text, y: box.y, x: box.x });
    }
  }
  dates.sort((left, right) => left.y - right.y || left.x - right.x);
  incompleteLines.sort((left, right) => left.y - right.y || left.x - right.x);
  return { dates, incompleteLines };
}

function monthValue(date) {
  return date ? date.year * 12 + date.month - 1 : null;
}

function dayValue(date) {
  return date?.day ? date.year * 10000 + date.month * 100 + date.day : null;
}

function compareDates(left, right) {
  if (!left || !right) return null;
  if (left.day && right.day) return dayValue(left) - dayValue(right);
  return monthValue(left) - monthValue(right);
}

function formatDate(date) {
  if (!date) return "未识别";
  return `${date.year}-${String(date.month).padStart(2, "0")}${date.day ? `-${String(date.day).padStart(2, "0")}` : ""}${date.inferred ? "?" : ""}`;
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

function declarationCount(matches, pageNumber) {
  return (matches?.[pageNumber] || []).filter((match) => {
    const target = normalizeText(match.target);
    return target.includes("信仰") || target.includes("宗教") || target === "信仰声明";
  }).length;
}

function checkResult(label, status, detail, page, extra = {}) {
  return { label, status, detail, page: page || null, ...extra };
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
  const dominantYear = dominantDocumentYear(allPages, pageObjects.experience);
  const extracted = Object.fromEntries(Object.entries(pageObjects).map(([key, page]) => [
    key,
    page ? extractDates(page, dominantYear) : { dates: [], incompleteLines: [] }
  ]));
  const highlights = {};

  const birthLine = pageObjects.experience?.lines?.find((line) => normalizeText(line.text).includes("出生年月"));
  const birthData = birthLine
    ? extractDates({ page: pages.experience, lines: [birthLine] }, null).dates.find((date) => date.precision === "month" || date.precision === "day")
    : null;
  const studyDates = extracted.study.dates;
  const earliestStudy = studyDates.length
    ? [...studyDates].sort((left, right) => monthValue(left) - monthValue(right) || (left.day || 0) - (right.day || 0))[0]
    : null;
  let age;
  if (!pageObjects.experience || !pageObjects.study || !birthData || !earliestStudy) {
    age = checkResult("年龄", "pending", "出生年月或首次团课日期未完整识别", pages.experience || pages.study);
  } else if (extracted.study.incompleteLines.some((line) => line.y < earliestStudy.y)) {
    age = checkResult("年龄", "pending", `较早记录日期不完整 · ${formatDate(birthData)} → ${formatDate(earliestStudy)}`, pages.study);
  } else {
    const ageMonths = monthValue(earliestStudy) - monthValue(birthData);
    const passed = ageMonths >= 14 * 12;
    age = checkResult("年龄", passed ? "pass" : "fail", `${formatDate(birthData)} → ${formatDate(earliestStudy)} · ${Math.floor(ageMonths / 12)}岁${ageMonths % 12}个月`, passed ? pages.study : pages.experience, {
      focus: passed ? earliestStudy.boxes[0] : birthData.boxes[0]
    });
    if (!passed) {
      addHighlight(highlights, birthData, "error", "首次团课时未满14周岁");
      addHighlight(highlights, earliestStudy, "error", "首次团课时未满14周岁");
    }
  }

  const sequenceRoles = ["study", "applicationSecond", "introducer", "secretary"];
  const sequence = [];
  let incompleteCount = 0;
  for (const role of sequenceRoles) {
    const page = pageObjects[role];
    if (!page) continue;
    const bottomLimit = role === "secretary" ? page.height * 0.82 : Number.POSITIVE_INFINITY;
    const pageDates = extracted[role].dates.filter((date) => date.y < bottomLimit);
    sequence.push(...pageDates);
    incompleteCount += pageDates.filter((date) => date.uncertain).length;
    incompleteCount += extracted[role].incompleteLines.filter((line) => line.y < bottomLimit).length;
  }
  const orderIssues = [];
  let previous = null;
  for (const current of sequence) {
    if (current.uncertain) continue;
    if (previous && compareDates(current, previous) < 0) {
      orderIssues.push(current);
      addHighlight(highlights, current, "error", "日期顺序倒置");
    }
    previous = current;
  }
  const missingSequencePages = sequenceRoles.filter((role) => !pageObjects[role]).length;
  const dateOrder = orderIssues.length
    ? checkResult("日期顺序", "fail", `${orderIssues.length}处倒序${incompleteCount ? ` · ${incompleteCount}处待确认` : ""}`, orderIssues[0].page, { issueCount: orderIssues.length, focus: orderIssues[0].boxes[0] })
    : incompleteCount || missingSequencePages
      ? checkResult("日期顺序", "pending", `${incompleteCount}处日期不完整${missingSequencePages ? ` · 缺${missingSequencePages}类页面` : ""}`, sequence[0]?.page || pages.study, { issueCount: 0 })
      : checkResult("日期顺序", "pass", `${sequence.length}个日期顺序正常`, pages.study, { issueCount: 0 });

  const declarationCounts = {
    application: declarationCount(declarationMatches, pages.application) + declarationCount(declarationMatches, pages.applicationSecond),
    introducer: declarationCount(declarationMatches, pages.introducer),
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
    declarationDetail,
    declarationPage
  );

  const secretaryPage = pageObjects.secretary;
  const secretaryLine = secretaryPage?.lines?.find((line) => normalizeText(line.text).includes("支部书记签名"));
  const secretaryBox = secretaryLine ? lineBox(secretaryLine) : null;
  const secretaryDate = secretaryBox
    ? extracted.secretary.dates
      .filter((date) => date.x > secretaryBox.x && Math.abs(date.y - secretaryBox.y) <= secretaryPage.height * 0.06)
      .sort((left, right) => Math.abs(left.y - secretaryBox.y) - Math.abs(right.y - secretaryBox.y))[0]
    : null;
  const approvalDate = extracted.secretary.dates.find((date) =>
    date.y > (secretaryBox?.y || 0) &&
    date.y < (secretaryPage?.height || 0) * 0.82 &&
    normalizeText(date.lineText).includes("算起"));
  let joinDate;
  if (!secretaryPage || !secretaryDate?.day || !approvalDate?.day) {
    joinDate = checkResult("入团日期", "pending", "书记签名日期或审批入团日期未完整识别", pages.secretary);
  } else {
    const same = dayValue(secretaryDate) === dayValue(approvalDate);
    joinDate = checkResult("入团日期", same ? "pass" : "fail", `${formatDate(secretaryDate)} ↔ ${formatDate(approvalDate)}`, pages.secretary, {
      focus: same ? approvalDate.boxes[0] : secretaryDate.boxes[0]
    });
    if (!same) {
      addHighlight(highlights, secretaryDate, "error", "入团日期不一致");
      addHighlight(highlights, approvalDate, "error", "入团日期不一致");
    }
  }

  const activistLine = secretaryPage?.lines?.find((line) => normalizeText(line.text).includes("被确定为入团积极分子"));
  let activist;
  if (!activistLine) {
    activist = checkResult("积极分子", "pass", "未出现相关月份表述", pages.secretary);
  } else {
    const activistEntry = {
      page: pages.secretary,
      boxes: [lineBox(activistLine)].filter(Boolean)
    };
    addHighlight(highlights, activistEntry, "notice", "确认入团积极分子日期");
    const activistDate = extractDates({ page: pages.secretary, lines: [activistLine] }, dominantYear).dates[0];
    if (!activistDate || !earliestStudy) {
      activist = checkResult("积极分子", "pending", "积极分子月份或首次团课日期未完整识别", pages.secretary, {
        focus: activistEntry.boxes[0]
      });
    } else {
      const passed = monthValue(activistDate) <= monthValue(earliestStudy);
      activist = checkResult("积极分子", passed ? "pass" : "fail", `${formatDate(activistDate)} ${passed ? "≤" : ">"} ${formatDate(earliestStudy)}`, pages.secretary, {
        focus: activistEntry.boxes[0]
      });
      if (!passed) addHighlight(highlights, activistEntry, "error", "积极分子日期晚于首次团课");
    }
  }

  return {
    pages,
    checks: { age, dateOrder, declaration, joinDate, activist },
    highlights,
    progress: 100
  };
}
