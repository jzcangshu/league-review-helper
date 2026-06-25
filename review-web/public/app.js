const STORAGE_KEY = "review-shortcuts-v1";
const SCHOOL_FILTER_KEY = "review-school-filter-v1";

const defaultShortcuts = [
  "基本信息未填写完整",
  "时间顺序不一致",
  "团课学习记录不足 8 学时",
  "上级团委审批意见未盖章",
  "入团时间与支部大会通过时间不一致"
];

const state = {
  items: [],
  notes: null,
  currentIndex: 0,
  currentReviewId: null,
  currentReviewContent: "",
  dirty: false,
  saving: false,
  shortcuts: loadShortcuts(),
  sources: [],
  candidates: [],
  selectedSchool: localStorage.getItem(SCHOOL_FILTER_KEY) || "all",
  eventsAttached: false
};

const elements = {
  studentTitle: document.getElementById("studentTitle"),
  studentMeta: document.getElementById("studentMeta"),
  schoolSelect: document.getElementById("schoolSelect"),
  studentSelect: document.getElementById("studentSelect"),
  reviewText: document.getElementById("reviewText"),
  noteList: document.getElementById("noteList"),
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  saveButton: document.getElementById("saveButton"),
  appendSeparatorButton: document.getElementById("appendSeparatorButton"),
  saveStatus: document.getElementById("saveStatus"),
  pdfStatus: document.getElementById("pdfStatus"),
  matchInfo: document.getElementById("matchInfo"),
  pdfFrame: document.getElementById("pdfFrame"),
  pdfEmpty: document.getElementById("pdfEmpty"),
  pdfLabel: document.getElementById("pdfLabel"),
  shortcutList: document.getElementById("shortcutList"),
  candidateSelect: document.getElementById("candidateSelect"),
  schoolNameInput: document.getElementById("schoolNameInput"),
  folderPathInput: document.getElementById("folderPathInput"),
  importButton: document.getElementById("importButton"),
  importStatus: document.getElementById("importStatus")
};

function loadShortcuts() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(stored) && stored.length === 5) {
      return stored.map((item, index) => (typeof item === "string" ? item : defaultShortcuts[index]));
    }
  } catch {}
  return [...defaultShortcuts];
}

function saveShortcuts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.shortcuts));
}

function setSaveStatus(text) {
  elements.saveStatus.textContent = text;
}

function markDirty(dirty) {
  state.dirty = dirty;
  if (state.saving) {
    return;
  }
  setSaveStatus(dirty ? "有未保存修改" : "已同步到 txt");
}

function buildStudentOption(item) {
  const option = document.createElement("option");
  option.value = item.id;
  const filteredIndex = getFilteredItems().findIndex((entry) => entry.id === item.id);
  const sequence = filteredIndex >= 0 ? filteredIndex + 1 : item.sequence;
  const schoolLabel = state.selectedSchool === "all" ? ` | ${item.school}` : "";
  option.textContent = `${String(sequence).padStart(3, "0")}${schoolLabel} | ${item.studentName}${item.hasPdf ? "" : " | 缺 PDF"}`;
  return option;
}

function getSchools() {
  return [...new Set(state.items.map((item) => item.school))]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
}

function getFilteredItems() {
  if (state.selectedSchool === "all") {
    return state.items;
  }
  return state.items.filter((item) => item.school === state.selectedSchool);
}

function renderSchoolOptions() {
  const schools = getSchools();
  if (state.selectedSchool !== "all" && !schools.includes(state.selectedSchool)) {
    state.selectedSchool = "all";
    localStorage.setItem(SCHOOL_FILTER_KEY, state.selectedSchool);
  }

  elements.schoolSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = `全部学校 (${state.items.length})`;
  elements.schoolSelect.appendChild(allOption);

  for (const school of schools) {
    const option = document.createElement("option");
    option.value = school;
    const count = state.items.filter((item) => item.school === school).length;
    option.textContent = `${school} (${count})`;
    elements.schoolSelect.appendChild(option);
  }

  elements.schoolSelect.value = state.selectedSchool;
}

function renderStudentOptions() {
  elements.studentSelect.innerHTML = "";
  for (const item of getFilteredItems()) {
    elements.studentSelect.appendChild(buildStudentOption(item));
  }
}

function renderNotes() {
  elements.noteList.innerHTML = "";
  for (const line of state.notes) {
    const item = document.createElement("li");
    item.textContent = line.replace(/^(?:第?[一二三四五六七八九十百\d]+[.．、])\s*/, "");
    elements.noteList.appendChild(item);
  }
}

function renderShortcuts() {
  elements.shortcutList.innerHTML = "";
  state.shortcuts.forEach((phrase, index) => {
    const row = document.createElement("div");
    row.className = "shortcut-item";

    const label = document.createElement("div");
    label.className = "shortcut-index";
    label.textContent = `小键盘 ${index + 1}`;

    const input = document.createElement("input");
    input.className = "shortcut-input";
    input.value = phrase;
    input.addEventListener("input", () => {
      state.shortcuts[index] = input.value;
      saveShortcuts();
    });

    const useButton = document.createElement("button");
    useButton.className = "shortcut-use";
    useButton.type = "button";
    useButton.textContent = "插入";
    useButton.addEventListener("click", () => insertShortcut(index));

    row.append(label, input, useButton);
    elements.shortcutList.appendChild(row);
  });
}

function renderImportControls() {
  elements.candidateSelect.innerHTML = "";

  if (!state.candidates.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未发现候选资料文件夹";
    elements.candidateSelect.appendChild(option);
    return;
  }

  for (const candidate of state.candidates) {
    const option = document.createElement("option");
    option.value = candidate.folderRelativePath;
    option.dataset.school = candidate.suggestedSchool;
    option.textContent = `${candidate.imported ? "已导入" : "可导入"} | ${candidate.suggestedSchool} | PDF ${candidate.pdfCount} | TXT ${candidate.txtCount} | ${candidate.folderRelativePath}`;
    elements.candidateSelect.appendChild(option);
  }

  applySelectedCandidate();
}

function applySelectedCandidate() {
  const option = elements.candidateSelect.selectedOptions[0];
  if (!option || !option.value) {
    return;
  }
  elements.folderPathInput.value = option.value;
  elements.schoolNameInput.value = option.dataset.school || "";
}

async function loadSources() {
  const response = await fetch("/api/sources");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "读取资料目录失败");
  }
  state.sources = payload.sources || [];
  state.candidates = payload.candidates || [];
  renderImportControls();
}

async function importSelectedSource() {
  const school = elements.schoolNameInput.value.trim();
  const folderRelativePath = elements.folderPathInput.value.trim();
  if (!school || !folderRelativePath) {
    elements.importStatus.textContent = "请填写学校和路径";
    return;
  }
  if (!(await saveCurrentReview())) {
    return;
  }

  elements.importButton.disabled = true;
  elements.importStatus.textContent = "正在导入...";
  try {
    const response = await fetch("/api/sources/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ school, folderRelativePath })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "导入失败");
    }
    elements.importStatus.textContent = `已导入 PDF ${payload.pdfCount}，新建 ${payload.created}，已有 ${payload.existing}`;
    await loadSources();
    await loadBootstrapData(0);
  } catch (error) {
    elements.importStatus.textContent = `导入失败：${error.message}`;
  } finally {
    elements.importButton.disabled = false;
  }
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const current = textarea.value;
  const prefix = current.slice(0, start);
  const suffix = current.slice(end);
  const needsSeparator = prefix.trim() && !/[；;\n]$/.test(prefix);
  const insertText = needsSeparator ? `；${text}` : text;
  textarea.value = `${prefix}${insertText}${suffix}`;
  const cursor = prefix.length + insertText.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.focus();
  handleReviewInput();
}

function insertShortcut(index) {
  const phrase = state.shortcuts[index]?.trim();
  if (!phrase) {
    return;
  }
  insertAtCursor(elements.reviewText, phrase);
}

function insertSeparator() {
  const textarea = elements.reviewText;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const current = textarea.value;
  const prefix = current.slice(0, start);
  const suffix = current.slice(end);
  const insertText = /[；;]\s*$/.test(prefix) ? "" : "；";
  if (!insertText) {
    return;
  }
  textarea.value = `${prefix}${insertText}${suffix}`;
  const cursor = prefix.length + insertText.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.focus();
  handleReviewInput();
}

function updatePdfArea(item) {
  if (item.hasPdf) {
    elements.pdfFrame.hidden = false;
    elements.pdfEmpty.hidden = true;
    elements.pdfFrame.src = item.pdfUrl;
    elements.pdfStatus.textContent = "已匹配 PDF";
    elements.pdfStatus.className = "badge ok";
  } else {
    elements.pdfFrame.hidden = true;
    elements.pdfEmpty.hidden = false;
    elements.pdfFrame.removeAttribute("src");
    elements.pdfStatus.textContent = "缺少 PDF";
    elements.pdfStatus.className = "badge warn";
  }
  elements.matchInfo.textContent = item.hasPdf ? `匹配分数 ${item.matchScore}` : "请人工补查";
  elements.pdfLabel.textContent = item.hasPdf ? `PDF 预览 | ${item.studentName}` : "PDF 预览";
}

function updateHeader(item) {
  const filteredItems = getFilteredItems();
  const filteredIndex = filteredItems.findIndex((entry) => entry.id === item.id);
  const position = filteredIndex >= 0 ? filteredIndex + 1 : state.currentIndex + 1;
  const total = filteredItems.length || state.items.length;
  elements.studentTitle.textContent = item.studentName;
  elements.studentMeta.textContent = `${item.school} | 第 ${position} / ${total} 份 | ${item.reviewRelativePath}`;
  elements.schoolSelect.value = state.selectedSchool;
  elements.studentSelect.value = item.id;
  elements.prevButton.disabled = position <= 1;
  elements.nextButton.disabled = position >= total;
}

async function loadReview(item) {
  setSaveStatus("正在读取...");
  const response = await fetch(`/api/review/${item.id}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "读取审核结果失败");
  }
  state.currentReviewId = item.id;
  state.currentReviewContent = payload.content || "";
  elements.reviewText.value = state.currentReviewContent;
  markDirty(false);
}

async function saveCurrentReview() {
  if (!state.currentReviewId || state.saving) {
    return true;
  }
  if (!state.dirty) {
    return true;
  }

  state.saving = true;
  setSaveStatus("正在保存...");

  try {
    const response = await fetch(`/api/review/${state.currentReviewId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: elements.reviewText.value })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "保存失败");
    }
    state.currentReviewContent = elements.reviewText.value;
    markDirty(false);
    setSaveStatus("已保存");
    return true;
  } catch (error) {
    setSaveStatus(`保存失败：${error.message}`);
    return false;
  } finally {
    state.saving = false;
  }
}

async function switchToIndex(index) {
  if (index < 0 || index >= state.items.length) {
    return;
  }
  if (!(await saveCurrentReview())) {
    return;
  }
  state.currentIndex = index;
  const item = state.items[index];
  updateHeader(item);
  updatePdfArea(item);
  await loadReview(item);
  localStorage.setItem("review-last-index", String(index));
}

async function switchToItem(item) {
  if (!item) {
    return;
  }
  const index = state.items.findIndex((entry) => entry.id === item.id);
  await switchToIndex(index);
}

async function switchToFilteredOffset(offset) {
  const filteredItems = getFilteredItems();
  if (!filteredItems.length) {
    return;
  }
  const currentItem = state.items[state.currentIndex];
  const currentFilteredIndex = filteredItems.findIndex((item) => item.id === currentItem?.id);
  const baseIndex = currentFilteredIndex >= 0 ? currentFilteredIndex : 0;
  const nextIndex = baseIndex + offset;
  await switchToItem(filteredItems[nextIndex]);
}

function handleReviewInput() {
  const changed = elements.reviewText.value !== state.currentReviewContent;
  markDirty(changed);
}

function attachEvents() {
  if (state.eventsAttached) {
    return;
  }
  state.eventsAttached = true;

  elements.candidateSelect.addEventListener("change", applySelectedCandidate);

  elements.importButton.addEventListener("click", async () => {
    await importSelectedSource();
  });

  elements.schoolSelect.addEventListener("change", async (event) => {
    state.selectedSchool = event.target.value;
    localStorage.setItem(SCHOOL_FILTER_KEY, state.selectedSchool);
    renderStudentOptions();
    const filteredItems = getFilteredItems();
    const currentItem = state.items[state.currentIndex];
    const target = filteredItems.find((item) => item.id === currentItem?.id) || filteredItems[0];
    await switchToItem(target);
  });

  elements.studentSelect.addEventListener("change", async (event) => {
    const id = event.target.value;
    const index = state.items.findIndex((item) => item.id === id);
    await switchToIndex(index);
  });

  elements.prevButton.addEventListener("click", async () => {
    await switchToFilteredOffset(-1);
  });

  elements.nextButton.addEventListener("click", async () => {
    await switchToFilteredOffset(1);
  });

  elements.saveButton.addEventListener("click", async () => {
    await saveCurrentReview();
  });

  elements.appendSeparatorButton.addEventListener("click", () => {
    insertSeparator();
  });

  elements.reviewText.addEventListener("input", handleReviewInput);

  window.addEventListener("keydown", async (event) => {
    if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      await saveCurrentReview();
      return;
    }

    if (event.code === "ArrowLeft" && event.altKey) {
      event.preventDefault();
      await switchToFilteredOffset(-1);
      return;
    }

    if (event.code === "ArrowRight" && event.altKey) {
      event.preventDefault();
      await switchToFilteredOffset(1);
      return;
    }

    const shortcutMap = {
      Numpad1: 0,
      Numpad2: 1,
      Numpad3: 2,
      Numpad4: 3,
      Numpad5: 4
    };

    if (Object.hasOwn(shortcutMap, event.code)) {
      event.preventDefault();
      insertShortcut(shortcutMap[event.code]);
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });
}

async function bootstrap() {
  await loadSources();
  await loadBootstrapData();
  attachEvents();
}

async function loadBootstrapData(preferredIndex = null) {
  const response = await fetch("/api/bootstrap");
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "初始化失败");
  }
  state.items = payload.items;
  state.notes = payload.notes;
  renderSchoolOptions();
  renderStudentOptions();
  renderNotes();
  renderShortcuts();

  const storedIndex = preferredIndex === null ? Number(localStorage.getItem("review-last-index")) : preferredIndex;
  const filteredItems = getFilteredItems();
  const storedItem =
    Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < state.items.length
      ? state.items[storedIndex]
      : null;
  const startItem = filteredItems.find((item) => item.id === storedItem?.id) || filteredItems[0] || state.items[0];
  const startIndex = state.items.findIndex((item) => item.id === startItem?.id);
  await switchToIndex(startIndex);
}

bootstrap().catch((error) => {
  elements.studentTitle.textContent = "加载失败";
  elements.studentMeta.textContent = error.message;
  setSaveStatus("无法初始化");
});
