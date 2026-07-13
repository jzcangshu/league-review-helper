import * as pdfjsLib from "/vendor/pdf.mjs";
import { shouldAutoMarkReviewed } from "/review-timing.js";
import { findDocumentOcrMatches, transformOcrBox } from "/ocr-matcher.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";

const SHORTCUTS_KEY = "review-shortcuts-v3";
const LEGACY_SHORTCUTS_KEY = "review-shortcuts-v2";
const SCHOOL_FILTER_KEY = "review-school-filter-v2";
const LAST_ITEM_KEY = "review-last-item-v2";
const defaultShortcuts = [
  "基本信息未填写完整",
  "时间顺序不一致",
  "团课学习记录不足 8 学时",
  "上级团委审批意见未盖章",
  "入团时间与支部大会通过时间不一致",
  "本人经历填写不完整"
];

const state = {
  items: [],
  notes: [],
  sources: [],
  selectedSchool: localStorage.getItem(SCHOOL_FILTER_KEY) || "all",
  currentIndex: -1,
  currentReviewId: null,
  currentReviewContent: "",
  currentReviewReviewed: false,
  dirty: false,
  saving: false,
  saveTimer: null,
  shortcuts: loadShortcuts(),
  importStep: 1,
  pdfDir: "",
  excelPath: "",
  analysis: null,
  analysisPage: 1,
  importResult: null,
  pdfDocument: null,
  pdfRenderTask: null,
  pdfLoadToken: 0,
  pdfPage: 0,
  pdfScale: 1,
  pdfRotation: 0,
  pdfAutoFit: true,
  pdfReviewStartedAt: 0,
  pdfPageChanged: false,
  resizeTimer: null,
  pdfResizeObserver: null,
  exportSchool: "",
  exportExcelPath: "",
  ocrEnabled: true,
  ocrData: null,
  ocrMatches: {},
  ocrItemId: "",
  ocrLoadToken: 0
};

const elementIds = [
  "studentTitle", "studentMeta", "schoolSelect", "studentSelect", "reviewText", "noteList", "prevButton",
  "nextButton", "saveStatus", "pdfStatus", "matchInfo", "pdfLabel",
  "shortcutList", "importStatus", "manageSchoolsButton", "importBody", "importStep1",
  "importStep2", "importStep3", "importStep4", "pickPdfFolderButton",
  "pdfPathPreview", "excelPathPreview", "pickExcelButton", "backToImportStep1Button",
  "schoolNameInput", "resultColumnSelect", "backToImportStep2Button", "analyzeImportButton", "importMessage",
  "analysisSummary", "viewIssuesButton", "backToImportStep3Button", "editNotesButton", "importProgress", "reviewStateButton",
  "analysisDialogTitle", "analysisWizardProgress", "analysisPage1", "analysisPage2", "analysisPage3",
  "historyPreviewContainer", "recognitionSummary", "reportOutput", "analysisWizardMessage", "analysisBackButton",
  "analysisNextButton", "confirmImportButton", "finishAnalysisButton",
  "exportSchoolLabel", "exportStatus", "exportResultColumnSelect", "writeBackExcelButton",
  "prevPageButton", "nextPageButton", "pageIndicator", "zoomOutButton", "zoomIndicator", "zoomInButton",
  "rotateButton", "downloadButton", "ocrToggleButton", "ocrStatus", "pdfPageSurface", "ocrOverlay",
  "pdfCanvas", "pdfLoading", "pdfEmpty", "pdfStage", "pdfThumbnails", "issuesDialog",
  "closeIssuesDialogButton", "schoolsDialog", "closeSchoolsDialogButton", "sourceList",
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
    const stored = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || localStorage.getItem(LEGACY_SHORTCUTS_KEY) || "null");
    if (Array.isArray(stored) && stored.length === 6) return stored.map(String);
    if (Array.isArray(stored) && stored.length === 5) return [...stored.map(String), defaultShortcuts[5]];
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

function showImportStep(step) {
  state.importStep = step;
  const stepLabels = ["资料文件夹", "Excel 名单", "核对资料", "确认导入"];
  for (let index = 1; index <= 4; index += 1) {
    elements[`importStep${index}`].hidden = index !== step;
  }
  for (const marker of elements.importProgress.querySelectorAll("[data-step]")) {
    const markerStep = Number(marker.dataset.step);
    marker.classList.toggle("active", markerStep === step);
    marker.classList.toggle("done", markerStep < step);
    marker.textContent = markerStep < step ? `✓ ${stepLabels[markerStep - 1]}` : `${markerStep} ${stepLabels[markerStep - 1]}`;
  }
}

function setImportMessage(text, isError = false) {
  elements.importMessage.textContent = text;
  elements.importMessage.style.color = isError ? "#a62525" : "";
}

async function loadSources() {
  const payload = await api("/api/sources");
  state.sources = payload.sources || [];
  renderSourceList();
  const activeCount = state.sources.filter((source) => source.active).length;
  elements.importStatus.textContent = activeCount ? `已配置 ${activeCount} 校` : "尚未配置";
  updateExportPanel();
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

function getCurrentSchool() {
  const current = state.items[state.currentIndex];
  return state.selectedSchool !== "all" ? state.selectedSchool : current?.school || "";
}

function updateExportPanel() {
  const school = getCurrentSchool();
  if (state.exportSchool !== school) {
    state.exportSchool = school;
    state.exportExcelPath = "";
    elements.exportResultColumnSelect.hidden = true;
  }
  elements.exportSchoolLabel.textContent = school || "尚未选择学校";
  const source = state.sources.find((item) => item.school === school && item.active);
  if (!school) elements.exportStatus.textContent = "请先选择一所学校。";
  else if (source?.excelExists) elements.exportStatus.textContent = "已找到该学校名单，写入前会自动备份并按姓名去重。";
  else elements.exportStatus.textContent = "回填时请选择该学校的 Excel 名单。";
  elements.writeBackExcelButton.disabled = !school;
}

async function writeBackCurrentSchool() {
  const school = getCurrentSchool();
  if (!school) return;
  await saveCurrentReview();
  elements.writeBackExcelButton.disabled = true;
  try {
    const source = state.sources.find((item) => item.school === school && item.active);
    let excelPath = state.exportExcelPath || source?.excelPath || "";
    if (!excelPath || source?.excelExists === false) {
      const picked = await api("/api/picker/excel", { method: "POST" });
      if (!picked.path) return;
      excelPath = picked.path;
      state.exportExcelPath = excelPath;
    }
    if (!window.confirm(`确定将“${school}”的审核结果覆盖写入所选 Excel 吗？程序会先备份原文件。`)) return;
    elements.exportStatus.textContent = "正在备份并回填，请稍候...";
    const payload = await api("/api/export/excel", {
      method: "POST",
      body: JSON.stringify({
        school,
        excelPath,
        resultColumn: elements.exportResultColumnSelect.hidden ? "" : elements.exportResultColumnSelect.value
      })
    });
    if (payload.needsResultColumn) {
      elements.exportResultColumnSelect.innerHTML = "";
      for (const header of payload.resultColumnChoices || []) {
        const option = document.createElement("option");
        option.value = header;
        option.textContent = header;
        elements.exportResultColumnSelect.appendChild(option);
      }
      elements.exportResultColumnSelect.hidden = false;
      elements.exportStatus.textContent = "检测到多个问题列，请选择要覆盖写入的列后再次回填。";
      return;
    }
    elements.exportResultColumnSelect.hidden = true;
    elements.exportStatus.textContent = `回填完成：已审 ${payload.reviewed}，未审 ${payload.pending}，无资料 ${payload.missing}，新增 ${payload.appended} 人。`;
    await loadSources();
  } catch (error) {
    elements.exportStatus.textContent = `回填失败：${error.message}`;
  } finally {
    elements.writeBackExcelButton.disabled = false;
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
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在打开...";
  if (kind === "folder") elements.pdfPathPreview.textContent = "正在等待选择文件夹";
  else elements.excelPathPreview.textContent = "正在等待选择文件";
  try {
    const payload = await api(`/api/picker/${kind}`, { method: "POST" });
    if (!payload.path) return false;
    if (kind === "folder") {
      state.pdfDir = payload.path;
      elements.pdfPathPreview.textContent = payload.path;
      elements.schoolNameInput.value = suggestSchool(payload.path);
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
    button.textContent = originalText;
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
  showImportStep(3);
  elements.analyzeImportButton.disabled = true;
  elements.analyzeImportButton.hidden = true;
  elements.resultColumnSelect.hidden = true;
  setImportMessage("正在核对名单与资料...");
  try {
    const analysis = await api("/api/import/analyze", { method: "POST", body: JSON.stringify(importPayload()) });
    state.analysis = analysis;
    elements.schoolNameInput.value = analysis.school;
    if (analysis.needsResultColumn) {
      elements.resultColumnSelect.hidden = false;
      elements.analyzeImportButton.hidden = false;
      elements.resultColumnSelect.innerHTML = "";
      for (const choice of analysis.resultColumnChoices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        elements.resultColumnSelect.appendChild(option);
      }
      setImportMessage("检测到多个含“问题”的列，请选择正确列后继续。", true);
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
  state.importResult = null;
  renderHistoryPreview(analysis);
  renderRecognitionSummary(analysis);
  showAnalysisPage(1);
  if (!elements.issuesDialog.open) elements.issuesDialog.showModal();
}

function renderHistoryPreview(analysis) {
  elements.historyPreviewContainer.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "history-preview-title";
  const title = document.createElement("strong");
  title.textContent = "Excel 导入审核意见预览";
  const detected = document.createElement("span");
  detected.className = "hint";
  detected.textContent = analysis.resultColumn ? `自动识别列：${analysis.resultColumn}` : "未识别到历史问题列";
  heading.append(title, detected);

  const table = document.createElement("table");
  table.className = "history-preview-table";
  table.innerHTML = "<thead><tr><th>姓名</th><th>问题</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const item of analysis.historyPreview || []) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = item.name;
    const problem = document.createElement("td");
    problem.textContent = item.problem || "";
    row.append(name, problem);
    body.appendChild(row);
  }
  table.appendChild(body);
  elements.historyPreviewContainer.append(heading, table);
}

function createRecognitionGroup(title, items, renderRow, actions = []) {
  const group = document.createElement("section");
  group.className = "recognition-group";
  const head = document.createElement("div");
  head.className = "recognition-group-head";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const count = document.createElement("span");
  count.className = "recognition-count";
  count.textContent = `${items.length} 人`;
  head.append(heading, count);
  if (actions.length) {
    const actionBox = document.createElement("div");
    actionBox.className = "recognition-group-actions";
    actionBox.append(...actions);
    head.appendChild(actionBox);
  }
  const list = document.createElement("div");
  list.className = "recognition-list";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "recognition-empty";
    empty.textContent = "无";
    list.appendChild(empty);
  } else {
    for (const item of items) list.appendChild(renderRow(item));
  }
  group.append(head, list);
  return group;
}

function renderRecognitionSummary(analysis) {
  elements.recognitionSummary.innerHTML = "";
  const missingPdfNames = analysis.onlyExcel || [];
  const onlyPdfItems = (analysis.items || []).filter((item) => item.matchKind === "missing");
  const typoItems = (analysis.items || []).filter((item) => item.matchKind === "fuzzy" || item.matchKind === "ambiguous");

  const missingPdfGroup = createRecognitionGroup(
    "只在名单出现，无入团申请书 PDF",
    missingPdfNames,
    (name) => {
      const row = document.createElement("div");
      row.className = "recognition-row";
      const strong = document.createElement("strong");
      strong.textContent = name;
      const status = document.createElement("span");
      status.className = "hint";
      status.textContent = "名单中有此人，但没有匹配到 PDF";
      row.append(strong, status);
      return row;
    }
  );

  const setAll = (value) => {
    for (const select of elements.recognitionSummary.querySelectorAll("select[data-only-pdf-name]")) select.value = value;
    updateConfirmImportState();
  };
  const addAll = document.createElement("button");
  addAll.type = "button";
  addAll.className = "small-button";
  addAll.textContent = "全部新增到 Excel";
  addAll.addEventListener("click", () => setAll("__append__"));
  const skipAll = document.createElement("button");
  skipAll.type = "button";
  skipAll.className = "small-button";
  skipAll.textContent = "全部暂不导入";
  skipAll.addEventListener("click", () => setAll("__skip__"));
  const onlyPdfGroup = createRecognitionGroup(
    "只有入团申请书 PDF，未出现于名单中",
    onlyPdfItems,
    (item) => {
      const row = document.createElement("div");
      row.className = "recognition-row";
      const strong = document.createElement("strong");
      strong.textContent = item.name;
      const select = document.createElement("select");
      select.dataset.onlyPdfName = item.name;
      select.innerHTML = `<option value="__append__">新增到 Excel</option><option value="__skip__">暂不导入</option>`;
      for (const rosterName of analysis.rosterNames || []) {
        const option = document.createElement("option");
        option.value = rosterName;
        option.textContent = `绑定到名单中的 ${rosterName}`;
        select.appendChild(option);
      }
      select.value = "__append__";
      select.addEventListener("change", updateConfirmImportState);
      const openPdf = document.createElement("button");
      openPdf.type = "button";
      openPdf.className = "small-button";
      openPdf.textContent = "打开 PDF";
      openPdf.addEventListener("click", () => window.open(item.pdfPreviewUrl, "_blank", "noopener"));
      row.append(strong, select, openPdf);
      return row;
    },
    [addAll, skipAll]
  );

  const typoGroup = createRecognitionGroup(
    "疑似录入错别字",
    typoItems,
    (item) => {
      const row = document.createElement("div");
      row.className = "recognition-row typo-row";
      row.dataset.typoName = item.name;
      const copy = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = `PDF：${item.name}`;
      const hint = document.createElement("div");
      hint.className = "hint";
      const candidates = item.excelName ? [item.excelName] : item.matchCandidates || [];
      hint.textContent = `名单：${candidates.join("、")}`;
      copy.append(strong, hint);
      const choices = document.createElement("div");
      choices.className = "typo-choice-list";
      for (const candidate of candidates) {
        const excelCorrect = document.createElement("button");
        excelCorrect.type = "button";
        excelCorrect.className = "typo-choice";
        excelCorrect.dataset.bindingValue = `excel:${candidate}`;
        excelCorrect.textContent = `名单“${candidate}”正确`;
        const pdfCorrect = document.createElement("button");
        pdfCorrect.type = "button";
        pdfCorrect.className = "typo-choice";
        pdfCorrect.dataset.bindingValue = `pdf:${candidate}`;
        pdfCorrect.textContent = `PDF“${item.name}”正确`;
        for (const button of [excelCorrect, pdfCorrect]) {
          button.addEventListener("click", () => {
            for (const sibling of choices.querySelectorAll(".typo-choice")) sibling.classList.remove("active");
            button.classList.add("active");
            row.dataset.bindingValue = button.dataset.bindingValue;
            choices.classList.remove("needs-attention");
            updateConfirmImportState();
          });
        }
        const separator = document.createElement("span");
        separator.className = "typo-choice-or";
        separator.textContent = "or";
        choices.append(excelCorrect, separator, pdfCorrect);
      }
      const openPdf = document.createElement("button");
      openPdf.type = "button";
      openPdf.className = "small-button";
      openPdf.textContent = "打开 PDF 首页";
      openPdf.addEventListener("click", () => window.open(item.pdfPreviewUrl, "_blank", "noopener"));
      row.append(copy, choices, openPdf);
      return row;
    }
  );
  elements.recognitionSummary.append(missingPdfGroup, onlyPdfGroup, typoGroup);
  updateConfirmImportState();
}

function showAnalysisPage(page) {
  state.analysisPage = page;
  const titles = ["Excel 导入审核意见预览", "错漏人员自动识别", "生成名单核对报告"];
  elements.analysisDialogTitle.textContent = titles[page - 1];
  for (let index = 1; index <= 3; index += 1) elements[`analysisPage${index}`].hidden = index !== page;
  for (const marker of elements.analysisWizardProgress.querySelectorAll("[data-page]")) {
    const markerPage = Number(marker.dataset.page);
    marker.classList.toggle("active", markerPage === page);
    marker.classList.toggle("done", markerPage < page);
  }
  elements.analysisBackButton.hidden = page !== 2;
  elements.analysisNextButton.hidden = page !== 1;
  elements.confirmImportButton.hidden = page !== 2;
  elements.finishAnalysisButton.hidden = page !== 3;
  elements.analysisWizardMessage.textContent = page === 1
    ? "请确认姓名与问题两列识别正确。"
    : page === 2 ? "完成所有人员处理方案后才能导入。" : "名单核对报告已生成，可直接选择文字复制。";
  if (page === 2) updateConfirmImportState();
}

function collectBindings() {
  const bindings = {};
  for (const select of elements.recognitionSummary.querySelectorAll("select[data-only-pdf-name]")) {
    bindings[select.dataset.onlyPdfName] = select.value;
  }
  for (const row of elements.recognitionSummary.querySelectorAll("[data-typo-name]")) {
    if (!row.dataset.bindingValue) throw new Error(`请确认“${row.dataset.typoName}”的真实姓名。`);
    bindings[row.dataset.typoName] = row.dataset.bindingValue;
  }
  return bindings;
}

function updateConfirmImportState() {
  if (!state.analysis) return;
  const duplicateCount = (state.analysis.duplicates?.excel?.length || 0) + (state.analysis.duplicates?.pdf?.length || 0);
  const unresolved = [...elements.recognitionSummary.querySelectorAll("[data-typo-name]")]
    .filter((row) => !row.dataset.bindingValue).length;
  const blocked = duplicateCount > 0 || unresolved > 0;
  elements.confirmImportButton.setAttribute("aria-disabled", String(blocked));
  elements.confirmImportButton.classList.toggle("blocked", blocked);
  elements.analysisWizardMessage.classList.toggle("error", blocked);
  if (duplicateCount > 0) elements.analysisWizardMessage.textContent = "存在重复姓名，请修正源文件后重新核对。";
  else if (unresolved > 0) elements.analysisWizardMessage.textContent = `还有 ${unresolved} 人未确认真实姓名。`;
  else elements.analysisWizardMessage.textContent = "所有处理方案已完成，可以导入名单。";
}

function showUnresolvedImportFeedback() {
  const button = elements.confirmImportButton;
  button.classList.remove("shake");
  void button.offsetWidth;
  button.classList.add("shake");
  for (const row of elements.recognitionSummary.querySelectorAll("[data-typo-name]")) {
    if (!row.dataset.bindingValue) row.querySelector(".typo-choice-list")?.classList.add("needs-attention");
  }
}

function buildReportText() {
  const analysis = state.analysis;
  const bindings = collectBindings();
  const lines = ["只在名单出现，无入团申请书PDF"];
  lines.push(...(analysis.onlyExcel?.length ? analysis.onlyExcel : ["无"]));
  lines.push("", "只有入团申请书PDF，未出现于名单中");
  const onlyPdf = (analysis.items || []).filter((item) => item.matchKind === "missing");
  lines.push(...(onlyPdf.length ? onlyPdf.map((item) => item.name) : ["无"]));
  lines.push("", "姓名登记存在错别字");
  const typoItems = (analysis.items || []).filter((item) => item.matchKind === "fuzzy" || item.matchKind === "ambiguous");
  if (!typoItems.length) lines.push("无");
  for (const item of typoItems) {
    const decision = bindings[item.name];
    const [source, excelName] = decision.split(":");
    const realName = source === "excel" ? excelName : item.name;
    const method = source === "excel"
      ? `以Excel姓名“${excelName}”为准，统一PDF文件名和审核结果文件`
      : `以PDF姓名“${item.name}”为准，统一Excel名单和审核结果文件`;
    lines.push(`PDF姓名：${item.name}；Excel姓名：${excelName}；真实姓名：${realName}；处理方法：${method}`);
  }
  return lines.join("\n");
}

async function commitImport() {
  if (!state.analysis) return;
  if (elements.confirmImportButton.getAttribute("aria-disabled") === "true") {
    showUnresolvedImportFeedback();
    return;
  }
  elements.confirmImportButton.disabled = true;
  try {
    const bindings = collectBindings();
    const matchingSource = state.sources.find((source) => source.school === state.analysis.school);
    const payload = await api("/api/import/commit", {
      method: "POST",
      body: JSON.stringify({
        ...importPayload(),
        analysisId: state.analysis.analysisId,
        sourceId: matchingSource?.id || "",
        bindings,
        resolutions: {}
      })
    });
    elements.importStatus.textContent = `新建 ${payload.created}｜更新 ${payload.updated}｜新增名单 ${payload.appended || 0}`;
    state.importResult = payload;
    elements.reportOutput.textContent = buildReportText();
    showAnalysisPage(3);
    state.pdfDir = "";
    state.excelPath = "";
    elements.schoolNameInput.value = "";
    elements.pdfPathPreview.textContent = "等待选择";
    elements.excelPathPreview.textContent = "等待选择";
    elements.resultColumnSelect.hidden = true;
    await Promise.all([loadSources(), loadBootstrapData()]);
  } catch (error) {
    elements.analysisWizardMessage.textContent = `导入失败：${error.message}`;
  } finally {
    elements.confirmImportButton.disabled = false;
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

async function loadReview(item) {
  setSaveStatus("正在读取...");
  const payload = await api(`/api/review/${item.id}`);
  const serverContent = payload.content || "";
  const draft = localStorage.getItem(draftKey(item.id));
  state.currentReviewId = item.id;
  state.currentReviewContent = serverContent;
  state.currentReviewReviewed = Boolean(payload.reviewed);
  if (draft !== null && draft !== serverContent) {
    elements.reviewText.value = draft;
    markDirty(true, "已恢复未保存草稿");
  } else {
    elements.reviewText.value = serverContent;
    const reviewStatus = payload.reviewed
      ? serverContent.trim() ? "已审，有审核意见" : "已审，无问题"
      : "未审核";
    markDirty(false, reviewStatus);
  }
  updateReviewStateButton();
}

function updateReviewStateButton() {
  const item = state.items.find((entry) => entry.id === state.currentReviewId);
  const hasContent = Boolean(elements.reviewText.value.trim());
  elements.reviewStateButton.hidden = hasContent || !item;
  if (!item) return;
  elements.reviewStateButton.textContent = item.reviewed ? "标记为未审核" : "确认无问题";
  elements.reviewStateButton.classList.toggle("primary", !item.reviewed);
}

async function saveCurrentReview({ force = false } = {}) {
  clearTimeout(state.saveTimer);
  if (!state.currentReviewId || state.saving || (!state.dirty && !force)) return true;
  state.saving = true;
  setSaveStatus("正在保存...");
  try {
    const payload = await api(`/api/review/${state.currentReviewId}`, {
      method: "PUT",
      body: JSON.stringify({ content: elements.reviewText.value, reviewed: true })
    });
    state.currentReviewContent = elements.reviewText.value;
    localStorage.removeItem(draftKey(state.currentReviewId));
    const item = state.items.find((entry) => entry.id === state.currentReviewId);
    if (item) item.reviewed = Boolean(payload.reviewed);
    state.currentReviewReviewed = Boolean(payload.reviewed);
    markDirty(false, "已自动保存");
    renderSchoolOptions();
    renderStudentOptions();
    elements.studentSelect.value = state.currentReviewId;
    updateReviewStateButton();
    return true;
  } catch (error) {
    markDirty(true, `保存失败：${error.message}`);
    return false;
  } finally {
    state.saving = false;
  }
}

async function toggleEmptyReviewState() {
  const item = state.items.find((entry) => entry.id === state.currentReviewId);
  if (!item || elements.reviewText.value.trim()) return;
  elements.reviewStateButton.disabled = true;
  try {
    const payload = await api(`/api/review/${state.currentReviewId}`, {
      method: "PUT",
      body: JSON.stringify({ content: "", reviewed: !item.reviewed })
    });
    const becameReviewed = !item.reviewed && Boolean(payload.reviewed);
    item.reviewed = Boolean(payload.reviewed);
    state.currentReviewReviewed = item.reviewed;
    markDirty(false, item.reviewed ? "已确认无问题" : "已改为未审核");
    renderSchoolOptions();
    renderStudentOptions();
    elements.studentSelect.value = state.currentReviewId;
    updateReviewStateButton();
    if (becameReviewed) await switchFilteredOffset(1);
  } catch (error) {
    setSaveStatus(`状态修改失败：${error.message}`);
  } finally {
    elements.reviewStateButton.disabled = false;
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
  updateExportPanel();
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
    elements.reviewStateButton.hidden = true;
    updateExportPanel();
    await loadPdf(null);
    return;
  }
  await switchToIndex(state.items.findIndex((entry) => entry.id === item.id));
}

async function switchFilteredOffset(offset) {
  await markCurrentReviewedFromPdfViewing();
  const filtered = getFilteredItems();
  const current = state.items[state.currentIndex];
  const index = filtered.findIndex((item) => item.id === current?.id);
  const target = filtered[index + offset];
  if (target) await switchToItem(target);
}

async function markCurrentReviewedFromPdfViewing() {
  const item = state.items[state.currentIndex];
  if (!item || !shouldAutoMarkReviewed({
    reviewed: item.reviewed,
    hasPdf: item.hasPdf,
    pageChanged: state.pdfPageChanged,
    startedAt: state.pdfReviewStartedAt
  })) return false;
  const payload = await api(`/api/review/${item.id}`, {
    method: "PUT",
    body: JSON.stringify({ content: elements.reviewText.value, reviewed: true })
  });
  item.reviewed = Boolean(payload.reviewed);
  state.currentReviewReviewed = item.reviewed;
  state.currentReviewContent = elements.reviewText.value;
  localStorage.removeItem(draftKey(item.id));
  markDirty(false, elements.reviewText.value.trim() ? "已审，有审核意见" : "已审，无问题");
  renderSchoolOptions();
  renderStudentOptions();
  elements.studentSelect.value = item.id;
  updateReviewStateButton();
  return true;
}

function handleReviewInput() {
  if (!state.currentReviewId) return;
  localStorage.setItem(draftKey(state.currentReviewId), elements.reviewText.value);
  markDirty(elements.reviewText.value !== state.currentReviewContent);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentReview, 900);
  updateReviewStateButton();
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

function resetOcrState(itemId = "") {
  state.ocrData = null;
  state.ocrMatches = {};
  state.ocrItemId = itemId;
  state.ocrLoadToken += 1;
  elements.ocrOverlay.innerHTML = "";
  elements.ocrStatus.textContent = itemId ? "OCR 识别中" : "OCR 等待中";
}

function renderOcrHighlights() {
  elements.ocrOverlay.innerHTML = "";
  if (!state.ocrEnabled || !state.ocrData || !state.pdfPage || elements.pdfPageSurface.hidden) return;
  const page = (state.ocrData.pages || []).find((entry) => Number(entry.page) === state.pdfPage);
  const matches = state.ocrMatches[state.pdfPage] || [];
  if (!page) return;
  const viewportWidth = Number.parseFloat(elements.pdfCanvas.style.width) || elements.pdfCanvas.clientWidth;
  const viewportHeight = Number.parseFloat(elements.pdfCanvas.style.height) || elements.pdfCanvas.clientHeight;
  elements.ocrOverlay.style.width = `${viewportWidth}px`;
  elements.ocrOverlay.style.height = `${viewportHeight}px`;
  for (const match of matches) {
    for (const sourceBox of match.boxes) {
      const box = transformOcrBox(
        sourceBox,
        page.width,
        page.height,
        viewportWidth,
        viewportHeight,
        state.pdfRotation
      );
      const highlight = document.createElement("div");
      highlight.className = `ocr-highlight${match.approximate ? " approximate" : ""}`;
      highlight.title = `${match.target}（疑似匹配 ${Math.round(match.score * 100)}%）`;
      highlight.style.left = `${Math.max(0, box.left)}px`;
      highlight.style.top = `${Math.max(0, box.top)}px`;
      highlight.style.width = `${Math.max(4, box.width)}px`;
      highlight.style.height = `${Math.max(4, box.height)}px`;
      elements.ocrOverlay.appendChild(highlight);
    }
  }
  elements.ocrStatus.textContent = matches.length ? `本页标注 ${matches.length} 处` : "本页未匹配";
}

async function loadOcrHighlights(item, pdfLoadToken) {
  const ocrLoadToken = state.ocrLoadToken;
  if (!state.ocrEnabled || !item?.hasPdf) return;
  elements.ocrStatus.textContent = "OCR 识别中";
  try {
    const payload = await api(`/api/ocr/${encodeURIComponent(item.id)}`);
    if (!state.ocrEnabled || pdfLoadToken !== state.pdfLoadToken || ocrLoadToken !== state.ocrLoadToken || state.ocrItemId !== item.id) return;
    state.ocrData = payload;
    state.ocrMatches = findDocumentOcrMatches(payload);
    const totalMatches = Object.values(state.ocrMatches).reduce((sum, matches) => sum + matches.length, 0);
    elements.ocrStatus.textContent = totalMatches ? `共标注 ${totalMatches} 处` : "未找到可靠匹配";
    renderOcrHighlights();
  } catch (error) {
    if (pdfLoadToken !== state.pdfLoadToken || ocrLoadToken !== state.ocrLoadToken) return;
    elements.ocrStatus.textContent = "OCR 不可用";
    elements.ocrStatus.title = error.message;
  }
}

async function loadPdf(item) {
  state.pdfReviewStartedAt = 0;
  state.pdfPageChanged = false;
  const loadToken = ++state.pdfLoadToken;
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  if (state.pdfDocument) await state.pdfDocument.destroy().catch(() => {});
  state.pdfDocument = null;
  state.pdfPage = 0;
  state.pdfScale = 1;
  state.pdfRotation = 0;
  state.pdfAutoFit = true;
  resetOcrState(item?.id || "");
  elements.pdfThumbnails.innerHTML = "";
  updatePdfControls();
  if (!item?.hasPdf) {
    elements.pdfPageSurface.hidden = true;
    elements.pdfEmpty.hidden = false;
    elements.pdfLoading.hidden = true;
    elements.pdfLabel.textContent = "PDF 预览";
    elements.matchInfo.textContent = "";
    return;
  }
  elements.pdfPageSurface.hidden = true;
  elements.pdfEmpty.hidden = true;
  elements.pdfLoading.hidden = false;
  elements.pdfLabel.textContent = `PDF 预览 | ${item.studentName}`;
  elements.matchInfo.textContent = item.matchQuality === "准确" ? "匹配正常" : item.matchQuality;
  try {
    state.pdfDocument = await pdfjsLib.getDocument(`/api/pdf/${encodeURIComponent(item.id)}`).promise;
    state.pdfPage = 1;
    await renderPdfPage({ fit: true });
    state.pdfReviewStartedAt = Date.now();
    renderPdfThumbnails(state.pdfDocument, loadToken);
    loadOcrHighlights(item, loadToken);
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
  elements.pdfPageSurface.hidden = false;
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
  renderOcrHighlights();
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
      if (state.pdfPage !== pageNumber) state.pdfPageChanged = true;
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
    const scale = Math.min(168 / baseViewport.width, 224 / baseViewport.height);
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
  state.pdfPageChanged = true;
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
  elements.manageSchoolsButton.addEventListener("click", () => elements.schoolsDialog.showModal());
  elements.closeSchoolsDialogButton.addEventListener("click", () => elements.schoolsDialog.close());
  elements.pickPdfFolderButton.addEventListener("click", async () => {
    if (await choosePath("folder")) {
      state.excelPath = "";
      elements.excelPathPreview.textContent = "等待选择";
      showImportStep(2);
    }
  });
  elements.pickExcelButton.addEventListener("click", async () => {
    if (await choosePath("excel")) await analyzeImport();
  });
  elements.backToImportStep1Button.addEventListener("click", () => {
    state.pdfDir = "";
    elements.pdfPathPreview.textContent = "等待选择";
    showImportStep(1);
  });
  elements.backToImportStep2Button.addEventListener("click", () => {
    state.excelPath = "";
    elements.excelPathPreview.textContent = "等待选择";
    elements.resultColumnSelect.hidden = true;
    showImportStep(2);
  });
  elements.analyzeImportButton.addEventListener("click", analyzeImport);
  elements.backToImportStep3Button.addEventListener("click", () => showImportStep(2));
  elements.viewIssuesButton.addEventListener("click", () => {
    showAnalysisPage(state.importResult ? 3 : state.analysisPage || 1);
    elements.issuesDialog.showModal();
  });
  elements.closeIssuesDialogButton.addEventListener("click", () => elements.issuesDialog.close());
  elements.analysisNextButton.addEventListener("click", () => showAnalysisPage(2));
  elements.analysisBackButton.addEventListener("click", () => showAnalysisPage(1));
  elements.confirmImportButton.addEventListener("click", commitImport);
  elements.finishAnalysisButton.addEventListener("click", () => {
    elements.issuesDialog.close();
    state.analysis = null;
    state.importResult = null;
    showImportStep(1);
  });
  elements.writeBackExcelButton.addEventListener("click", writeBackCurrentSchool);
  elements.ocrToggleButton.addEventListener("click", () => {
    state.ocrEnabled = !state.ocrEnabled;
    elements.ocrToggleButton.classList.toggle("active", state.ocrEnabled);
    elements.ocrToggleButton.setAttribute("aria-pressed", String(state.ocrEnabled));
    if (!state.ocrEnabled) {
      elements.ocrOverlay.innerHTML = "";
      elements.ocrStatus.textContent = "OCR 已关闭";
      return;
    }
    const item = state.items[state.currentIndex];
    if (state.ocrData) renderOcrHighlights();
    else if (item?.hasPdf) loadOcrHighlights(item, state.pdfLoadToken);
  });

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
  elements.reviewStateButton.addEventListener("click", toggleEmptyReviewState);
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
    const shortcut = { Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4, Numpad6: 5 }[event.code];
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
