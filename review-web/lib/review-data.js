const path = require("node:path");
const crypto = require("node:crypto");

function clean(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function normalizeStudentName(input, school = "") {
  let value = path.basename(String(input || ""), path.extname(String(input || "")));
  value = value.replace(/^转PDF[_\-\s]*/i, "");
  value = value.replace(/pdf/gi, "");
  value = value.replace(/[_\-\s]*\d{6,}(?:[_\-\s]*\d+)?$/g, "");
  value = value.replace(/^\d{3}\s*班?\s*/g, "");
  if (school) {
    value = value.replaceAll(school, "");
  }
  for (const token of [
    "入团申请书",
    "入团志愿书",
    "入团申请",
    "入团志愿",
    "申请书",
    "志愿书",
    "审核结果",
    "团员资料"
  ]) {
    value = value.replaceAll(token, "");
  }
  return value.replace(/[\s_\-—－()（）]+/g, "").trim();
}

function detectResultColumns(headers) {
  const normalized = headers.map((header, index) => ({
    index,
    header: String(header ?? "").trim(),
    cleaned: clean(header)
  }));
  const rules = [
    { priority: 1, label: "问题备注", matches: (header) => header === "问题备注" },
    { priority: 2, label: "问题", matches: (header) => header === "问题" },
    { priority: 3, label: "包含问题", matches: (header) => header.includes("问题") }
  ];

  for (const rule of rules) {
    const candidates = normalized
      .filter((entry) => entry.cleaned && rule.matches(entry.cleaned))
      .map((entry) => ({ ...entry, priority: rule.priority, label: rule.label }));
    if (candidates.length) {
      return {
        selected: candidates.length === 1 ? candidates[0] : null,
        candidates,
        ambiguous: candidates.length > 1
      };
    }
  }
  return { selected: null, candidates: [], ambiguous: false };
}

function normalizeReviewContent(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function classifyReviewConflict(excelContent, txtExists, txtContent) {
  const excel = normalizeReviewContent(excelContent);
  const txt = normalizeReviewContent(txtContent);
  if (excel === "无资料") {
    return { action: "skip_missing_sentinel", excel, txt, requiresDecision: false };
  }
  if (!excel) {
    return {
      action: txtExists && txt ? "keep_txt" : "blank",
      excel,
      txt,
      requiresDecision: false
    };
  }
  if (!txtExists) {
    return { action: "create_from_excel", excel, txt, requiresDecision: false };
  }
  if (!txt) {
    return { action: "fill_empty", excel, txt, requiresDecision: false };
  }
  if (excel === txt) {
    return { action: "same", excel, txt, requiresDecision: false };
  }
  return { action: "conflict", excel, txt, requiresDecision: true };
}

function stableSourceId(school, folderPath) {
  const digest = crypto
    .createHash("sha1")
    .update(`${clean(school)}\n${String(folderPath || "").toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
  return `school-${digest}`;
}

function migrateSource(source) {
  const school = String(source?.school || "").trim();
  const folderPath = String(source?.folderPath || source?.folderRelativePath || "").trim();
  return {
    id: String(source?.id || stableSourceId(school, folderPath)),
    school,
    folderPath,
    excelPath: String(source?.excelPath || "").trim(),
    active: source?.active !== false,
    createdAt: source?.createdAt || null,
    updatedAt: source?.updatedAt || null
  };
}

function isConfidentNameMatch(left, right) {
  const a = clean(left);
  const b = clean(right);
  if (a === b) return true;
  if (!a || !b || a.length !== b.length || a[0] !== b[0]) return false;
  let differences = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) differences += 1;
  }
  return differences === 1;
}

function updateSourceState(sources, sourceId, active) {
  let found = false;
  const updatedAt = new Date().toISOString();
  const next = sources.map((source) => {
    const migrated = migrateSource(source);
    if (migrated.id !== sourceId) return migrated;
    found = true;
    return { ...migrated, active: Boolean(active), updatedAt };
  });
  if (!found) throw new Error("未找到要管理的学校。");
  return next;
}

function isSchoolActive(school, sources) {
  const matches = sources.map(migrateSource).filter((source) => source.school === school);
  if (!matches.length) return true;
  return matches.some((source) => source.active);
}

module.exports = {
  classifyReviewConflict,
  clean,
  detectResultColumns,
  isConfidentNameMatch,
  isSchoolActive,
  migrateSource,
  normalizeReviewContent,
  normalizeStudentName,
  stableSourceId,
  updateSourceState
};
