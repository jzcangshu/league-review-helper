export const OCR_TARGETS = [
  {
    label: "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
    phrases: [
      "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
      "只信仰马克思主义",
      "无其他宗教信仰",
      "未参加任何宗教活动"
    ]
  },
  { label: "马克思列宁主义", phrases: ["马克思列宁主义"] },
  { label: "毛泽东思想", phrases: ["毛泽东思想"] },
  { label: "邓小平理论", phrases: ["邓小平理论"] },
  { label: "三个代表重要思想", phrases: ["三个代表重要思想"] },
  { label: "科学发展观", phrases: ["科学发展观"] },
  { label: "习近平新时代中国特色社会主义", phrases: ["习近平新时代中国特色社会主义"] }
];

export function normalizeOcrText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : Math.min(diagonal, above, previous[rightIndex - 1]) + 1;
      diagonal = above;
    }
  }
  return previous[right.length];
}

function lcsLength(left, right) {
  const row = Array(right.length + 1).fill(0);
  for (const leftChar of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = row[index];
      row[index] = leftChar === right[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

function sharedCharacterCount(left, right) {
  const counts = new Map();
  for (const char of right) counts.set(char, (counts.get(char) || 0) + 1);
  let shared = 0;
  for (const char of left) {
    const count = counts.get(char) || 0;
    if (count > 0) {
      shared += 1;
      counts.set(char, count - 1);
    }
  }
  return shared;
}

function bigramDice(left, right) {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const counts = new Map();
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  let shared = 0;
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    const count = counts.get(pair) || 0;
    if (count > 0) {
      shared += 1;
      counts.set(pair, count - 1);
    }
  }
  return (2 * shared) / (left.length + right.length - 2);
}

export function fuzzyTextScore(target, candidate) {
  const normalizedTarget = normalizeOcrText(target);
  const normalizedCandidate = normalizeOcrText(candidate);
  if (!normalizedTarget || !normalizedCandidate) return { score: 0, shared: 0 };
  const longest = Math.max(normalizedTarget.length, normalizedCandidate.length);
  const shared = sharedCharacterCount(normalizedTarget, normalizedCandidate);
  const lcs = lcsLength(normalizedTarget, normalizedCandidate);
  const editSimilarity = 1 - levenshtein(normalizedTarget, normalizedCandidate) / longest;
  const score =
    (lcs / normalizedTarget.length) * 0.5 +
    editSimilarity * 0.25 +
    (shared / normalizedTarget.length) * 0.15 +
    bigramDice(normalizedTarget, normalizedCandidate) * 0.1;
  return { score, shared };
}

function matchThreshold(length) {
  if (length <= 4) return { score: 0.52, shared: 2 };
  if (length <= 7) return { score: 0.43, shared: 3 };
  if (length <= 12) return { score: 0.36, shared: 3 };
  return { score: 0.3, shared: 4 };
}

function flattenPage(page) {
  const words = [];
  const chars = [];
  for (let lineIndex = 0; lineIndex < (page.lines || []).length; lineIndex += 1) {
    for (const word of page.lines[lineIndex].words || []) {
      const normalized = normalizeOcrText(word.text);
      if (!normalized) continue;
      const wordIndex = words.length;
      words.push({ ...word, lineIndex });
      for (const char of normalized) chars.push({ char, wordIndex });
    }
  }
  return { words, chars };
}

function boxesForRange(words, startWord, endWord) {
  const byLine = new Map();
  for (let index = startWord; index <= endWord; index += 1) {
    const word = words[index];
    const current = byLine.get(word.lineIndex);
    const right = word.x + word.width;
    const bottom = word.y + word.height;
    if (!current) byLine.set(word.lineIndex, { x: word.x, y: word.y, right, bottom });
    else {
      current.x = Math.min(current.x, word.x);
      current.y = Math.min(current.y, word.y);
      current.right = Math.max(current.right, right);
      current.bottom = Math.max(current.bottom, bottom);
    }
  }
  return [...byLine.values()].map((box) => ({
    x: box.x,
    y: box.y,
    width: box.right - box.x,
    height: box.bottom - box.y
  }));
}

function bestPhraseMatches(page, target, phrase) {
  const { words, chars } = flattenPage(page);
  const normalizedPhrase = normalizeOcrText(phrase);
  if (!normalizedPhrase || !chars.length) return [];
  const threshold = matchThreshold(normalizedPhrase.length);
  const sizes = [...new Set([0.7, 0.85, 1, 1.15, 1.3].map((ratio) =>
    Math.max(2, Math.round(normalizedPhrase.length * ratio))))];
  const candidates = [];
  for (let start = 0; start < chars.length; start += 1) {
    for (const size of sizes) {
      const end = start + size;
      if (end > chars.length) continue;
      const candidateText = chars.slice(start, end).map((entry) => entry.char).join("");
      const result = fuzzyTextScore(normalizedPhrase, candidateText);
      if (result.score < threshold.score || result.shared < threshold.shared) continue;
      const startWord = chars[start].wordIndex;
      const endWord = chars[end - 1].wordIndex;
      candidates.push({
        target,
        phrase,
        score: result.score,
        startWord,
        endWord,
        boxes: boxesForRange(words, startWord, endWord)
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.startWord - right.startWord);
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((match) =>
      candidate.startWord <= match.endWord && candidate.endWord >= match.startWord);
    if (!overlaps) selected.push(candidate);
    if (selected.length >= 3) break;
  }
  return selected;
}

export function findOcrTargetMatches(page, targets = OCR_TARGETS) {
  const matches = [];
  for (const target of targets) {
    const targetMatches = target.phrases.flatMap((phrase) => bestPhraseMatches(page, target.label, phrase));
    targetMatches.sort((left, right) => right.score - left.score);
    const selected = [];
    for (const candidate of targetMatches) {
      const overlaps = selected.some((match) =>
        candidate.startWord <= match.endWord && candidate.endWord >= match.startWord);
      if (!overlaps) selected.push(candidate);
      if (selected.length >= 3) break;
    }
    matches.push(...selected);
  }
  return matches;
}

export function findDocumentOcrMatches(ocrData, targets = OCR_TARGETS) {
  const pages = ocrData.pages || [];
  const relevantPages = new Set();
  for (const page of pages) {
    const text = normalizeOcrText((page.lines || []).map((line) => line.text).join(""));
    if (["入团志愿", "入团介绍", "支部大会"].some((heading) => text.includes(heading))) {
      relevantPages.add(page.page);
      relevantPages.add(page.page + 1);
    }
  }
  return Object.fromEntries(pages.map((page) => [
    page.page,
    relevantPages.size && !relevantPages.has(page.page) ? [] : findOcrTargetMatches(page, targets)
  ]));
}

export function transformOcrBox(box, sourceWidth, sourceHeight, viewportWidth, viewportHeight, rotation = 0) {
  const x = box.x / sourceWidth;
  const y = box.y / sourceHeight;
  const width = box.width / sourceWidth;
  const height = box.height / sourceHeight;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  if (normalizedRotation === 90) {
    return {
      left: (1 - y - height) * viewportWidth,
      top: x * viewportHeight,
      width: height * viewportWidth,
      height: width * viewportHeight
    };
  }
  if (normalizedRotation === 180) {
    return {
      left: (1 - x - width) * viewportWidth,
      top: (1 - y - height) * viewportHeight,
      width: width * viewportWidth,
      height: height * viewportHeight
    };
  }
  if (normalizedRotation === 270) {
    return {
      left: y * viewportWidth,
      top: (1 - x - width) * viewportHeight,
      width: height * viewportWidth,
      height: width * viewportHeight
    };
  }
  return {
    left: x * viewportWidth,
    top: y * viewportHeight,
    width: width * viewportWidth,
    height: height * viewportHeight
  };
}
