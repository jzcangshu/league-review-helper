import * as pdfjsLib from "/vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";

const SHORTCUTS_KEY = "review-shortcuts-v2";
const SCHOOL_FILTER_KEY = "review-school-filter-v2";
const LAST_ITEM_KEY = "review-last-item-v2";
const defaultShortcuts = [
  "基本信息未填写完整",
  "时间顺序不一致",
  "团课学习记录不足 8 学时",
  "上级团委审批意见未盖章",
  "入团时间与支部大会通过时间不一致"
];

const state = {
  items: [],
  notes: [],
  sources: [],
  candidates: [],
  selectedSchool: localStorage.getItem(SCHOOL_FILTER_KEY) || "all",
  currentIndex: -1,
  currentReviewId: null,
  currentReviewContent: "",
  dirty: false,
  saving: false,
  saveTimer: null,
  shortcuts: loadShortcuts(),
  importStep: 1,
  importOpen: false,
  pdfDir: "",
  excelPath: "",
  analysis: null,
  pdfDocument: null,
  pdfRenderTask: null,
  pdfLoadToken: 0,
  pdfPage: 0,
  pdfScale: 1,
  pdfRotation: 0,
  pdfAutoFit: true,
  resizeTimer: null,
  pdfResizeObserver: null
};

const elementIds = [
  "studentTitle", "studentMeta", "schoolSelect", "studentSelect", "reviewText", "noteList", "prevButton",
  "nextButton", "saveButton", "appendSeparatorButton", "saveStatus", "pdfStatus", "matchInfo", "pdfLabel",
  "shortcutList", "importStatus", "manageSchoolsButton", "toggleImportButton", "importBody", "importStep1",
  "importStep2", "importStep3", "importStep4", "candidateSelect", "pickPdfFolderButton", "toImportStep2Button",
  "pdfPathPreview", "excelPathPreview", "pickExcelButton", "backToImportStep1Button", "toImportStep3Button",
  "schoolNameInput", "resultColumnSelect", "backToImportStep2Button", "analyzeImportButton", "importMessage",
  "analysisSummary", "viewIssuesButton", "backToImportStep3Button", "commitImportButton", "editNotesButton",
  "prevPageButton", "nextPageButton", "pageIndicator", "zoomOutButton", "zoomIndicator", "zoomInButton",
  "rotateButton", "downloadButton", "pdfCanvas", "pdfLoading", "pdfEmpty", "pdfStage", "pdfThumbnails", "issuesDialog",
  "closeIssuesDialogButton", "issueSummary", "schoolsDialog", "closeSchoolsDialogButton", "sourceList",
  "notesDialog", "closeNotesDialogButton", "notesEditor", "notesMessage", "saveNotesButton"
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "操作失败，请稍后重试。");
  return payload;
}

function loadShortcuts() {
  try {
    const stored = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || "null");
    if (Array.isArray(stored) && stored.length === 5) return stored.map(String);
  } catch {}
  return [...defaultShortcuts];
}

function saveShortcuts() {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(state.shortcuts));
}

function setSaveStatus(text) {
  elements.saveStatus.textContent = text;
}

function markDirty(dirty, message = "") {
  state.dirty = dirty;
  if (!state.saving) setSaveStatus(message || (dirty ? "有未保存修改" : "已保存"));
}

function draftKey(itemId) {
  return `review-draft-v1:${itemId}`;
}

function suggestSchool(inputPath) {
  const parts = String(inputPath || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return "";
  const generic = new Set(["资料", "团员资料", "入团申请资料", "入团志愿书", "PDF"]);
  return generic.has(parts.at(-1)) && parts.length > 1 ? parts.at(-2) : parts.at(-1);
}

function setImportOpen(open) {
  state.importOpen = open;
  elements.importBody.hidden = !open;
  elements.toggleImportButton.textContent = open ? "收起" : "展开";
}

function showImportStep(step) {
  state.importStep = step;
  for (let index = 1; index <= 4; index += 1) {
    elements[`importStep${index}`].hidden = index !== step;
  }
}

function setImportMessage(text, isError = false) {
  elements.importMessage.textContent = text;
  elements.importMessage.style.color = isError ? "#a62525" : "";
}

async function loadSources() {
  const payload = await api("/api/sources");
  state.sources = payload.sources || [];
  state.candidates = payload.candidates || [];
  renderCandidateOptions();
  renderSourceList();
  const activeCount = state.sources.filter((source) => source.active).length;
  elements.importStatus.textContent = activeCount ? `已配置 ${activeCount} 校` : "尚未配置";
  if (!activeCount) setImportOpen(true);
}

function renderCandidateOptions() {
  elements.candidateSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.candidates.length ? "选择已发现的资料文件夹" : "未发现候选资料文件夹";
  elements.candidateSelect.appendChild(placeholder);
  for (const candidate of state.candidates) {
    const option = document.createElement("option");
    option.value = candidate.folderPath;
    option.dataset.school = candidate.suggestedSchool;
    option.textContent = `${candidate.imported ? "已导入" : "可导入"}｜${candidate.suggestedSchool}｜${candidate.pdfCount} 份`;
    elements.candidateSelect.appendChild(option);
  }
}

function renderSourceList() {
  elements.sourceList.innerHTML = "";
  if (!state.sources.length) {
    elements.sourceList.textContent = "还没有导入学校。";
    return;
  }
  for (const source of state.sources) {
    const row = document.createElement("div");
    row.className = "source-row";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = source.school;
    const detail = document.createElement("div");
    detail.className = "hint";
    detail.textContent = source.active
      ? source.folderExists ? "正在审核列表中使用" : "资料位置已失效"
      : "已隐藏，资料与审核结果仍保留";
    copy.append(name, detail);
    const button = document.createElement("button");
    button.className = "small-button";
    button.type = "button";
    button.textContent = source.active ? "移除" : "恢复";
    button.addEventListener("click", () => changeSourceState(source));
    row.append(copy, button);
    elements.sourceList.appendChild(row);
  }
}

async function changeSourceState(source) {
  const message = source.active
    ? `确定移除“${source.school}”吗？只会从审核列表隐藏，不会删除文件。`
    : `确定恢复“${source.school}”吗？`;
  if (!window.confirm(message)) return;
  try {
    await api(`/api/sources/${encodeURIComponent(source.id)}/${source.active ? "remove" : "restore"}`, { method: "POST" });
    await Promise.all([loadSources(), loadBootstrapData()]);
  } catch (error) {
    window.alert(error.message);
  }
}

async function choosePath(kind) {
  const button = kind === "folder" ? elements.pickPdfFolderButton : elements.pickExcelButton;
  button.disabled = true;
  try {
    const payload = await api(`/api/picker/${kind}`, { method: "POST" });
    if (!payload.path) return false;
    if (kind === "folder") {
      state.pdfDir = payload.path;
      elements.pdfPathPreview.textContent = payload.path;
      if (!elements.schoolNameInput.value.trim()) elements.schoolNameInput.value = suggestSchool(payload.path);
    } else {
      state.excelPath = payload.path;
      elements.excelPathPreview.textContent = payload.path;
    }
    return true;
  } catch (error) {
    window.alert(`选择失败：${error.message}`);
    return false;
  } finally {
    button.disabled = false;
  }
}

function importPayload() {
  return {
    school: elements.schoolNameInput.value.trim(),
    pdfDir: state.pdfDir,
    excelPath: state.excelPath,
    resultColumn: elements.resultColumnSelect.hidden ? "" : elements.resultColumnSelect.value
  };
}

async function analyzeImport() {
  if (!state.pdfDir || !state.excelPath) {
    setImportMessage("请先完成前两步。", true);
    return;
  }
  elements.analyzeImportButton.disabled = true;
  setImportMessage("正在核对名单与资料...");
  try {
    const analysis = await api("/api/import/analyze", { method: "POST", body: JSON.stringify(importPayload()) });
    state.analysis = analysis;
    elements.schoolNameInput.value = analysis.school;
    if (analysis.needsResultColumn) {
      elements.resultColumnSelect.hidden = false;
      elements.resultColumnSelect.innerHTML = "";
      for (const choice of analysis.resultColumnChoices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        elements.resultColumnSelect.appendChild(option);
      }
      setImportMessage("请选择历史审核结果列，再次点击检查资料。", true);
      return;
    }
    renderAnalysis(analysis);
    showImportStep(4);
  } catch (error) {
    setImportMessage(`检查失败：${error.message}`, true);
  } finally {
    elements.analyzeImportButton.disabled = false;
  }
}

function renderAnalysis(analysis) {
  const summary = analysis.summary;
  elements.analysisSummary.textContent =
    `资料 ${summary.pdfCount}｜名单 ${summary.rosterCount}｜匹配 ${summary.matchedCount}｜历史结果 ${summary.historyCount}｜冲突 ${summary.conflictCount}`;
  const duplicateCount = (analysis.duplicates?.excel?.length || 0) + (analysis.duplicates?.pdf?.length || 0);
  elements.commitImportButton.disabled = duplicateCount > 0;
  renderIssues(analysis);
}

function appendIssue(title, content) {
  if (!content) return;
  const block = document.createElement("div");
  block.className = "issue-block";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("div");
  text.className = "hint";
  text.textContent = content;
  block.append(strong, text);
  elements.issueSummary.appendChild(block);
}

function renderIssues(analysis) {
  elements.issueSummary.innerHTML = "";
  appendIssue("只在名单出现", analysis.onlyExcel?.join("、"));
  appendIssue("只在资料出现", analysis.onlyPdf?.join("、"));
  appendIssue("疑似姓名差异", analysis.fuzzyMatches?.map((item) => `${item.excelName}/${item.pdfName}`).join("、"));
  appendIssue("名单重复姓名", analysis.duplicates?.excel?.join("、"));
  appendIssue("资料重复姓名", analysis.duplicates?.pdf?.join("、"));

  const conflicts = (analysis.items || []).filter((item) => item.conflict?.requiresDecision);
  for (const item of conflicts) {
    const row = document.createElement("div");
    row.className = "conflict-row";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const local = document.createElement("div");
    local.className = "conflict-copy";
    local.textContent = `本地：${item.txtContent}\n名单：${item.excelResult}`;
    copy.append(name, local);
    const select = document.createElement("select");
    select.dataset.conflictName = item.name;
    select.innerHTML = `
      <option value="keep_txt">保留本地</option>
      <option value="use_excel">使用名单</option>
      <option value="merge">合并两份</option>
    `;
    row.append(copy, select);
    elements.issueSummary.appendChild(row);
  }
  if (!elements.issueSummary.children.length) {
    appendIssue("核对结果", "名单、资料和历史结果没有发现差异。 ");
  }
}

function collectResolutions() {
  const resolutions = {};
  for (const select of elements.issueSummary.querySelectorAll("select[data-conflict-name]")) {
    resolutions[select.dataset.conflictName] = select.value;
  }
  return resolutions;
}

async function commitImport() {
  if (!state.analysis) return;
  elements.commitImportButton.disabled = true;
  try {
    const matchingSource = state.sources.find((source) => source.school === state.analysis.school);
    const payload = await api("/api/import/commit", {
      method: "POST",
      body: JSON.stringify({ ...importPayload(), sourceId: matchingSource?.id || "", resolutions: collectResolutions() })
    });
    elements.importStatus.textContent = `新建 ${payload.created}｜更新 ${payload.updated}｜保留 ${payload.kept}`;
    state.analysis = null;
    showImportStep(1);
    setImportOpen(false);
    await Promise.all([loadSources(), loadBootstrapData()]);
  } catch (error) {
    window.alert(`导入失败：${error.message}`);
  } finally {
    elements.commitImportButton.disabled = false;
  }
}

function getSchools() {
  return [...new Set(state.items.map((item) => item.school))].sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
}

function getFilteredItems() {
  if (state.selectedSchool === "all") return state.items;
  return state.items.filter((item) => item.school === state.selectedSchool);
}

function renderSchoolOptions() {
  const schools = getSchools();
  if (state.selectedSchool !== "all" && !schools.includes(state.selectedSchool)) state.selectedSchool = "all";
  elements.schoolSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = `全部学校 (${state.items.length})`;
  elements.schoolSelect.appendChild(all);
  for (const school of schools) {
    const schoolItems = state.items.filter((item) => item.school === school);
    const reviewed = schoolItems.filter((item) => item.reviewed).length;
    const option = document.createElement("option");
    option.value = school;
    option.textContent = `${school} (${reviewed}/${schoolItems.length})`;
    elements.schoolSelect.appendChild(option);
  }
  elements.schoolSelect.value = state.selectedSchool;
}

function renderStudentOptions() {
  elements.studentSelect.innerHTML = "";
  const filtered = getFilteredItems();
  for (const [index, item] of filtered.entries()) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${String(index + 1).padStart(3, "0")} | ${item.studentName}${item.reviewed ? " | 已审" : ""}${item.hasPdf ? "" : " | 缺 PDF"}`;
    elements.studentSelect.appendChild(option);
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
    const button = document.createElement("button");
    button.className = "shortcut-use";
    button.type = "button";
    button.textContent = "插入";
    button.addEventListener("click", () => insertAtCursor(input.value));
    row.append(label, input, button);
    elements.shortcutList.appendChild(row);
  });
}

function insertAtCursor(text) {
  if (!state.currentReviewId || !text.trim()) return;
  const textarea = elements.reviewText;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const prefix = textarea.value.slice(0, start);
  const separator = prefix.trim() && !/[；;\n]$/.test(prefix) ? "；" : "";
  textarea.value = `${prefix}${separator}${text}${textarea.value.slice(end)}`;
  const cursor = prefix.length + separator.length + text.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.focus();
  handleReviewInput();
}

function insertSeparator() {
  const textarea = elements.reviewText;
  const start = textarea.selectionStart;
  const prefix = textarea.value.slice(0, start);
  if (/[；;]\s*$/.test(prefix)) return;
  textarea.value = `${prefix}；${textarea.value.slice(textarea.selectionEnd)}`;
  textarea.setSelectionRange(start + 1, start + 1);
  textarea.focus();
  handleReviewInput();
}

async function loadReview(item) {
  setSaveStatus("正在读取...");
  const payload = await api(`/api/review/${item.id}`);
  const serverContent = payload.content || "";
  const draft = localStorage.getItem(draftKey(item.id));
  state.currentReviewId = item.id;
  state.currentReviewContent = serverContent;
  if (draft !== null && draft !== serverContent) {
    elements.reviewText.value = draft;
    markDirty(true, "已恢复未保存草稿");
  } else {
    elements.reviewText.value = serverContent;
    markDirty(false, "已读取审核结果");
  }
}

async function saveCurrentReview() {
  clearTimeout(state.saveTimer);
  if (!state.currentReviewId || state.saving || !state.dirty) return true;
  state.saving = true;
  setSaveStatus("正在保存...");
  try {
    await api(`/api/review/${state.currentReviewId}`, {
      method: "PUT",
      body: JSON.stringify({ content: elements.reviewText.value })
    });
    state.currentReviewContent = elements.reviewText.value;
    localStorage.removeItem(draftKey(state.currentReviewId));
    const item = state.items.find((entry) => entry.id === state.currentReviewId);
    if (item) item.reviewed = Boolean(state.currentReviewContent.trim());
    markDirty(false, "已自动保存");
    renderSchoolOptions();
    renderStudentOptions();
    elements.studentSelect.value = state.currentReviewId;
    return true;
  } catch (error) {
    markDirty(true, `保存失败：${error.message}`);
    return false;
  } finally {
    state.saving = false;
  }
}

function updateHeader(item) {
  const filtered = getFilteredItems();
  const position = filtered.findIndex((entry) => entry.id === item.id) + 1;
  elements.studentTitle.textContent = item.studentName;
  elements.studentMeta.textContent = `${item.school} | 第 ${position} / ${filtered.length} 份`;
  elements.studentSelect.value = item.id;
  elements.prevButton.disabled = position <= 1;
  elements.nextButton.disabled = position >= filtered.length;
  elements.pdfStatus.textContent = item.hasPdf ? "已匹配 PDF" : "缺少 PDF";
  elements.pdfStatus.className = `badge ${item.hasPdf ? "ok" : "warn"}`;
}

async function switchToIndex(index) {
  if (index < 0 || index >= state.items.length) return;
  if (!(await saveCurrentReview())) return;
  state.currentIndex = index;
  const item = state.items[index];
  updateHeader(item);
  await Promise.all([loadReview(item), loadPdf(item)]);
  localStorage.setItem(LAST_ITEM_KEY, item.id);
}

async function switchToItem(item) {
  if (!item) {
    state.currentIndex = -1;
    state.currentReviewId = null;
    elements.studentTitle.textContent = "暂无审核资料";
    elements.studentMeta.textContent = "请导入学校或调整筛选";
    elements.reviewText.value = "";
    elements.reviewText.disabled = true;
    await loadPdf(null);
    return;
  }
  await switchToIndex(state.items.findIndex((entry) => entry.id === item.id));
}

async function switchFilteredOffset(offset) {
  const filtered = getFilteredItems();
  const current = state.items[state.currentIndex];
  const index = filtered.findIndex((item) => item.id === current?.id);
  await switchToItem(filtered[index + offset]);
}

function handleReviewInput() {
  if (!state.currentReviewId) return;
  localStorage.setItem(draftKey(state.currentReviewId), elements.reviewText.value);
  markDirty(elements.reviewText.value !== state.currentReviewContent);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentReview, 900);
}

async function loadBootstrapData() {
  const payload = await api("/api/bootstrap");
  state.items = payload.items || [];
  state.notes = payload.notes || [];
  renderSchoolOptions();
  renderStudentOptions();
  renderNotes();
  const filtered = getFilteredItems();
  const remembered = localStorage.getItem(LAST_ITEM_KEY);
  const target = filtered.find((item) => item.id === remembered) || filtered[0];
  await switchToItem(target);
}

async function editNotes() {
  elements.notesEditor.value = state.notes.join("\n");
  elements.notesMessage.textContent = "";
  elements.notesDialog.showModal();
}

async function saveNotes() {
  const notes = elements.notesEditor.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  elements.saveNotesButton.disabled = true;
  try {
    const payload = await api("/api/notes", { method: "PUT", body: JSON.stringify({ notes }) });
    state.notes = payload.notes;
    renderNotes();
    elements.notesDialog.close();
  } catch (error) {
    elements.notesMessage.textContent = `保存失败：${error.message}`;
  } finally {
    elements.saveNotesButton.disabled = false;
  }
}

async function loadPdf(item) {
  const loadToken = ++state.pdfLoadToken;
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  if (state.pdfDocument) await state.pdfDocument.destroy().catch(() => {});
  state.pdfDocument = null;
  state.pdfPage = 0;
  state.pdfScale = 1;
  state.pdfRotation = 0;
  state.pdfAutoFit = true;
  elements.pdfThumbnails.innerHTML = "";
  updatePdfControls();
  if (!item?.hasPdf) {
    elements.pdfCanvas.hidden = true;
    elements.pdfEmpty.hidden = false;
    elements.pdfLoading.hidden = true;
    elements.pdfLabel.textContent = "PDF 预览";
    elements.matchInfo.textContent = "";
    return;
  }
  elements.pdfCanvas.hidden = true;
  elements.pdfEmpty.hidden = true;
  elements.pdfLoading.hidden = false;
  elements.pdfLabel.textContent = `PDF 预览 | ${item.studentName}`;
  elements.matchInfo.textContent = item.matchQuality === "准确" ? "匹配正常" : item.matchQuality;
  try {
    state.pdfDocument = await pdfjsLib.getDocument(`/api/pdf/${encodeURIComponent(item.id)}`).promise;
    state.pdfPage = 1;
    await renderPdfPage({ fit: true });
    renderPdfThumbnails(state.pdfDocument, loadToken);
  } catch (error) {
    elements.pdfEmpty.hidden = false;
    elements.pdfEmpty.textContent = `资料打开失败：${error.message}`;
  } finally {
    elements.pdfLoading.hidden = true;
  }
}

function fitPdfScale(page) {
  const baseViewport = page.getViewport({ scale: 1, rotation: state.pdfRotation });
  const availableWidth = Math.max(1, elements.pdfStage.clientWidth - 24);
  const availableHeight = Math.max(1, elements.pdfStage.clientHeight - 24);
  return Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
}

async function renderPdfPage({ fit = false } = {}) {
  if (!state.pdfDocument || !state.pdfPage) return;
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  const page = await state.pdfDocument.getPage(state.pdfPage);
  if (fit || state.pdfAutoFit) state.pdfScale = fitPdfScale(page);
  const viewport = page.getViewport({ scale: state.pdfScale, rotation: state.pdfRotation });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = elements.pdfCanvas;
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.hidden = false;
  state.pdfRenderTask = page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
  });
  try {
    await state.pdfRenderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
  } finally {
    state.pdfRenderTask = null;
  }
  elements.pdfStage.scrollTo({ top: 0, behavior: "auto" });
  updateActiveThumbnail();
  updatePdfControls();
}

function updateActiveThumbnail() {
  for (const button of elements.pdfThumbnails.querySelectorAll(".pdf-thumbnail")) {
    const active = Number(button.dataset.page) === state.pdfPage;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
    if (active) button.scrollIntoView({ block: "nearest" });
  }
}

async function renderPdfThumbnails(pdfDocument, loadToken) {
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-thumbnail";
    button.dataset.page = String(pageNumber);
    button.title = `第 ${pageNumber} 页`;
    const canvas = document.createElement("canvas");
    const label = document.createElement("span");
    label.textContent = String(pageNumber);
    button.append(canvas, label);
    button.addEventListener("click", async () => {
      state.pdfPage = pageNumber;
      await renderPdfPage();
    });
    fragment.appendChild(button);
  }
  elements.pdfThumbnails.appendChild(fragment);
  updateActiveThumbnail();

  for (const button of elements.pdfThumbnails.querySelectorAll(".pdf-thumbnail")) {
    if (loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument) return;
    const page = await pdfDocument.getPage(Number(button.dataset.page));
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(84 / baseViewport.width, 112 / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = button.querySelector("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    try {
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
    } catch (error) {
      if (loadToken === state.pdfLoadToken) throw error;
      return;
    }
  }
}

function updatePdfControls() {
  const pages = state.pdfDocument?.numPages || 0;
  elements.pageIndicator.textContent = `${state.pdfPage || 0} / ${pages}`;
  elements.zoomIndicator.textContent = `${Math.round(state.pdfScale * 100)}%`;
  elements.prevPageButton.disabled = state.pdfPage <= 1;
  elements.nextPageButton.disabled = !pages || state.pdfPage >= pages;
  elements.zoomOutButton.disabled = !pages;
  elements.zoomInButton.disabled = !pages;
  elements.rotateButton.disabled = !pages;
  elements.downloadButton.disabled = !pages;
}

async function movePdfPage(offset) {
  const pages = state.pdfDocument?.numPages || 0;
  if (!pages) return;
  const next = Math.min(pages, Math.max(1, state.pdfPage + offset));
  if (next === state.pdfPage) return;
  state.pdfPage = next;
  await renderPdfPage();
}

async function changeZoom(delta) {
  if (!state.pdfDocument) return;
  state.pdfAutoFit = false;
  state.pdfScale = Math.min(2.5, Math.max(0.6, state.pdfScale + delta));
  await renderPdfPage();
}

async function rotatePdf() {
  if (!state.pdfDocument) return;
  state.pdfRotation = (state.pdfRotation + 90) % 360;
  state.pdfAutoFit = true;
  await renderPdfPage({ fit: true });
}

function attachEvents() {
  elements.toggleImportButton.addEventListener("click", () => setImportOpen(!state.importOpen));
  elements.manageSchoolsButton.addEventListener("click", () => elements.schoolsDialog.showModal());
  elements.closeSchoolsDialogButton.addEventListener("click", () => elements.schoolsDialog.close());
  elements.candidateSelect.addEventListener("change", () => {
    const option = elements.candidateSelect.selectedOptions[0];
    if (!option?.value) return;
    state.pdfDir = option.value;
    elements.pdfPathPreview.textContent = option.value;
    elements.schoolNameInput.value = option.dataset.school || suggestSchool(option.value);
  });
  elements.pickPdfFolderButton.addEventListener("click", () => choosePath("folder"));
  elements.toImportStep2Button.addEventListener("click", () => {
    if (!state.pdfDir) return window.alert("请先选择团员 PDF 资料文件夹。");
    showImportStep(2);
  });
  elements.pickExcelButton.addEventListener("click", () => choosePath("excel"));
  elements.backToImportStep1Button.addEventListener("click", () => showImportStep(1));
  elements.toImportStep3Button.addEventListener("click", () => {
    if (!state.excelPath) return window.alert("请先选择团员名单 Excel。");
    showImportStep(3);
  });
  elements.backToImportStep2Button.addEventListener("click", () => showImportStep(2));
  elements.analyzeImportButton.addEventListener("click", analyzeImport);
  elements.backToImportStep3Button.addEventListener("click", () => showImportStep(3));
  elements.viewIssuesButton.addEventListener("click", () => elements.issuesDialog.showModal());
  elements.closeIssuesDialogButton.addEventListener("click", () => elements.issuesDialog.close());
  elements.commitImportButton.addEventListener("click", commitImport);

  elements.schoolSelect.addEventListener("change", async () => {
    state.selectedSchool = elements.schoolSelect.value;
    localStorage.setItem(SCHOOL_FILTER_KEY, state.selectedSchool);
    renderStudentOptions();
    await switchToItem(getFilteredItems()[0]);
  });
  elements.studentSelect.addEventListener("change", () => switchToItem(state.items.find((item) => item.id === elements.studentSelect.value)));
  elements.prevButton.addEventListener("click", () => switchFilteredOffset(-1));
  elements.nextButton.addEventListener("click", () => switchFilteredOffset(1));
  elements.reviewText.addEventListener("input", handleReviewInput);
  elements.saveButton.addEventListener("click", saveCurrentReview);
  elements.appendSeparatorButton.addEventListener("click", insertSeparator);
  elements.editNotesButton.addEventListener("click", editNotes);
  elements.closeNotesDialogButton.addEventListener("click", () => elements.notesDialog.close());
  elements.saveNotesButton.addEventListener("click", saveNotes);

  elements.prevPageButton.addEventListener("click", () => movePdfPage(-1));
  elements.nextPageButton.addEventListener("click", () => movePdfPage(1));
  elements.zoomOutButton.addEventListener("click", () => changeZoom(-0.15));
  elements.zoomInButton.addEventListener("click", () => changeZoom(0.15));
  elements.rotateButton.addEventListener("click", rotatePdf);
  elements.downloadButton.addEventListener("click", () => {
    if (state.currentReviewId) window.open(`/api/pdf/${encodeURIComponent(state.currentReviewId)}/download`, "_blank", "noopener");
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "PageDown" || event.code === "PageUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      movePdfPage(event.code === "PageDown" ? 1 : -1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentReview();
      return;
    }
    const shortcut = { Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4 }[event.code];
    if (shortcut !== undefined && !elements.notesDialog.open) {
      event.preventDefault();
      insertAtCursor(state.shortcuts[shortcut]);
    }
  }, true);

  const refitPdf = () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (state.pdfDocument && state.pdfAutoFit) renderPdfPage({ fit: true });
    }, 120);
  };
  window.addEventListener("resize", refitPdf);
  if (window.ResizeObserver) {
    state.pdfResizeObserver = new ResizeObserver(refitPdf);
    state.pdfResizeObserver.observe(elements.pdfStage);
  }

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function bootstrap() {
  attachEvents();
  renderShortcuts();
  showImportStep(1);
  await loadSources();
  await loadBootstrapData();
}

bootstrap().catch((error) => {
  elements.studentTitle.textContent = "加载失败";
  elements.studentMeta.textContent = error.message;
  setSaveStatus("无法初始化");
});
