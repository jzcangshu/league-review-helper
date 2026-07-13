export const OCR_TARGETS = [
  {
    label: "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
    phrases: [
      "只信仰马克思主义，无其他宗教信仰，未参加任何宗教活动",
      "只信仰马克思主义",
      "无其他宗教信仰",
      "未参加任何宗教活动"
    ],
    fragments: [
      "只信仰", "马克思主义", "无其他", "其他宗教",
      "宗教信仰", "未参加", "任何宗教", "宗教活动"
    ],
    minimumFragments: 1,
    singleFragments: ["马克思主义", "宗教信仰", "任何宗教", "宗教活动"]
  },
  {
    label: "马克思列宁主义",
    phrases: [],
    fragments: ["马克思", "列宁"],
    requiredAny: ["列宁"]
  },
  {
    label: "毛泽东思想",
    phrases: [],
    fragments: ["毛泽东", "思想"],
    requiredAny: ["毛泽东"]
  },
  {
    label: "邓小平理论",
    phrases: [],
    fragments: ["邓小平", "理论"],
    requiredAny: ["邓小平"]
  },
  {
    label: "三个代表重要思想",
    phrases: [],
    fragments: ["三个代表", "重要思想"],
    requiredAny: ["三个代表"]
  },
  {
    label: "科学发展观",
    phrases: [],
    fragments: ["科学", "发展观"],
    requiredAny: ["科学"]
  },
  {
    label: "习近平新时代中国特色社会主义",
    phrases: [],
    fragments: ["习近平", "新时代", "中国特色社会主义"],
    requiredAny: ["习近平"]
  }
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
  if (length <= 4) return { score: 0.65, shared: 3 };
  if (length <= 7) return { score: 0.55, shared: 4 };
  if (length <= 12) return { score: 0.48, shared: 5 };
  return { score: 0.42, shared: 6 };
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
      for (let charOffset = 0; charOffset < normalized.length; charOffset += 1) {
        chars.push({
          char: normalized[charOffset],
          wordIndex,
          charOffset,
          charCount: normalized.length
        });
      }
    }
  }
  return { words, chars };
}

function boxesForRange(words, chars, startChar, endChar) {
  const byWord = new Map();
  for (let index = startChar; index <= endChar; index += 1) {
    const entry = chars[index];
    const current = byWord.get(entry.wordIndex);
    if (!current) {
      byWord.set(entry.wordIndex, {
        startOffset: entry.charOffset,
        endOffset: entry.charOffset,
        charCount: entry.charCount
      });
    } else {
      current.startOffset = Math.min(current.startOffset, entry.charOffset);
      current.endOffset = Math.max(current.endOffset, entry.charOffset);
    }
  }

  const byLine = new Map();
  for (const [wordIndex, range] of byWord) {
    const word = words[wordIndex];
    const x = word.x + word.width * (range.startOffset / range.charCount);
    const right = word.x + word.width * ((range.endOffset + 1) / range.charCount);
    const current = byLine.get(word.lineIndex);
    const bottom = word.y + word.height;
    if (!current) byLine.set(word.lineIndex, { x, y: word.y, right, bottom });
    else {
      current.x = Math.min(current.x, x);
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

function bestPhraseMatches(page, target, phrase, recall = false) {
  const { words, chars } = flattenPage(page);
  const normalizedPhrase = normalizeOcrText(phrase);
  if (!normalizedPhrase || !chars.length) return [];
  const threshold = recall
    ? {
      score: normalizedPhrase.length <= 4 ? 0.55 : 0.48,
      shared: Math.max(2, Math.ceil(normalizedPhrase.length * 0.6))
    }
    : matchThreshold(normalizedPhrase.length);
  const sizes = recall
    ? [...new Set([normalizedPhrase.length - 1, normalizedPhrase.length, normalizedPhrase.length + 1].map((size) => Math.max(2, size)))]
    : [...new Set([0.7, 0.85, 1, 1.15, 1.3].map((ratio) =>
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
        startChar: start,
        endChar: end - 1,
        startWord,
        endWord,
        boxes: boxesForRange(words, chars, start, end - 1),
        approximate: recall
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.startWord - right.startWord);
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((match) =>
      candidate.startChar <= match.endChar && candidate.endChar >= match.startChar);
    if (!overlaps) selected.push(candidate);
    if (selected.length >= 3) break;
  }
  return selected;
}

function centerY(match) {
  const top = Math.min(...match.boxes.map((box) => box.y));
  const bottom = Math.max(...match.boxes.map((box) => box.y + box.height));
  return (top + bottom) / 2;
}

function lineBoxes(matches, page, paddingRatio = 0.004) {
  const paddingX = page.width * paddingRatio;
  const paddingY = page.height * paddingRatio;
  const selected = [];
  for (const box of matches.flatMap((match) => match.boxes).sort((left, right) => left.y - right.y)) {
    const left = Math.max(0, box.x - paddingX);
    const top = Math.max(0, box.y - paddingY);
    const padded = {
      x: left,
      y: top,
      width: Math.min(page.width, box.x + box.width + paddingX) - left,
      height: Math.min(page.height, box.y + box.height + paddingY) - top
    };
    const sameLine = selected.find((current) => {
      const overlap = Math.min(current.y + current.height, padded.y + padded.height) - Math.max(current.y, padded.y);
      return overlap >= Math.min(current.height, padded.height) * 0.5;
    });
    if (!sameLine) {
      selected.push(padded);
      continue;
    }
    const right = Math.max(sameLine.x + sameLine.width, padded.x + padded.width);
    const bottom = Math.max(sameLine.y + sameLine.height, padded.y + padded.height);
    sameLine.x = Math.min(sameLine.x, padded.x);
    sameLine.y = Math.min(sameLine.y, padded.y);
    sameLine.width = right - sameLine.x;
    sameLine.height = bottom - sameLine.y;
  }
  return selected;
}

function findFragmentClusters(page, target) {
  const fragmentMatches = (target.fragments || []).flatMap((fragment) =>
    bestPhraseMatches(page, target.label, fragment, true));
  fragmentMatches.sort((left, right) => centerY(left) - centerY(right));
  const clusters = [];
  for (const match of fragmentMatches) {
    const cluster = clusters.find((candidate) =>
      Math.abs(candidate.center - centerY(match)) <= page.height * 0.08);
    if (cluster) {
      cluster.matches.push(match);
      cluster.center = cluster.matches.reduce((sum, item) => sum + centerY(item), 0) / cluster.matches.length;
    } else clusters.push({ center: centerY(match), matches: [match] });
  }
  return clusters.flatMap((cluster) => {
    const fragments = [...new Set(cluster.matches.map((match) => match.phrase))];
    const minimumFragments = target.minimumFragments || 2;
    if (fragments.length < minimumFragments) return [];
    if (fragments.length === 1 && target.singleFragments && !target.singleFragments.includes(fragments[0])) return [];
    if (target.requiredAny?.length && !target.requiredAny.some((required) => fragments.includes(required))) return [];
    return [{
      target: target.label,
      phrase: fragments.join(" + "),
      score: Math.max(...cluster.matches.map((match) => match.score)),
      boxes: lineBoxes(cluster.matches, page),
      approximate: true,
      fragmentCount: fragments.length
    }];
  });
}

function matchesOverlap(left, right) {
  return left.boxes.some((leftBox) => right.boxes.some((rightBox) => {
    const overlapWidth = Math.max(0, Math.min(leftBox.x + leftBox.width, rightBox.x + rightBox.width) - Math.max(leftBox.x, rightBox.x));
    const overlapHeight = Math.max(0, Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) - Math.max(leftBox.y, rightBox.y));
    const overlapArea = overlapWidth * overlapHeight;
    const smallerArea = Math.min(leftBox.width * leftBox.height, rightBox.width * rightBox.height);
    return smallerArea > 0 && overlapArea / smallerArea >= 0.3;
  }));
}

function matchesSameLine(left, right) {
  return left.boxes.some((leftBox) => right.boxes.some((rightBox) => {
    const overlap = Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) - Math.max(leftBox.y, rightBox.y);
    return overlap >= Math.min(leftBox.height, rightBox.height) * 0.5;
  }));
}

export function findOcrTargetMatches(page, targets = OCR_TARGETS) {
  const matches = [];
  for (const target of targets) {
    const partialPhrases = target.phrases.filter((phrase) =>
      normalizeOcrText(phrase) !== normalizeOcrText(target.label));
    const partialMatches = partialPhrases.flatMap((phrase) => bestPhraseMatches(page, target.label, phrase));
    const fullMatches = partialMatches.length
      ? []
      : target.phrases.flatMap((phrase) => bestPhraseMatches(page, target.label, phrase));
    const directMatches = partialMatches.length ? partialMatches : fullMatches;
    directMatches.sort((left, right) => right.score - left.score);
    const anchor = directMatches[0];
    const targetMatches = anchor
      ? directMatches.filter((candidate) => matchesOverlap(candidate, anchor) || matchesSameLine(candidate, anchor))
      : findFragmentClusters(page, target);
    targetMatches.sort((left, right) => right.score - left.score);
    const selected = [];
    for (const candidate of targetMatches) {
      const existing = selected.find((match) => matchesOverlap(candidate, match) || matchesSameLine(candidate, match));
      if (existing) {
        existing.boxes = lineBoxes([existing, candidate], page);
        existing.score = Math.max(existing.score, candidate.score);
        continue;
      }
      selected.push(candidate);
    }
    matches.push(...selected.slice(0, 3));
  }
  return matches;
}

export function findDocumentOcrMatches(ocrData, targets = OCR_TARGETS) {
  const pages = ocrData.pages || [];
  const relevantPages = new Set();
  for (const page of pages) {
    const hasApplicationHeading = (page.lines || []).some((line) => {
      const text = normalizeOcrText(line.text);
      return text === "入团志愿";
    });
    if (hasApplicationHeading) {
      for (let offset = 0; offset <= 4; offset += 1) relevantPages.add(page.page + offset);
    }
  }
  return Object.fromEntries(pages.map((page) => [
    page.page,
    (() => {
      if (relevantPages.size && !relevantPages.has(page.page)) return [];
      return findOcrTargetMatches(page, targets);
    })()
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
