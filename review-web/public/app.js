import * as pdfjsLib from "/vendor/pdf.mjs";
import { shouldAutoMarkReviewed } from "/review-timing.js";
import { findDocumentOcrMatches, transformOcrBox } from "/ocr-matcher.js";
import { analyzeOcrReview } from "/ocr-review.js";
import { classifyImportDecisions, importCandidateNames } from "/import-decisions.js";
import { parseNoteMarkdown } from "/note-markdown.js";
import { createThumbnailRenderQueue } from "/thumbnail-render-queue.js";
import { calculateContainedPdfScale } from "/pdf-fit.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";

const SHORTCUTS_KEY = "review-shortcuts-v3";
const LEGACY_SHORTCUTS_KEY = "review-shortcuts-v2";
const SCHOOL_FILTER_KEY = "review-school-filter-v2";
const LAST_ITEM_KEY = "review-last-item-v2";
const UPDATE_READ_KEY = "review-update-read-v1";
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
  pdfLoadingTask: null,
  pdfRenderTask: null,
  pdfThumbnailObserver: null,
  pdfThumbnailQueue: null,
  pdfLoadToken: 0,
  pdfPageRenderToken: 0,
  pdfMainRendering: false,
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
  lastExport: null,
  exportActionState: "idle",
  ocrEnabled: true,
  ocrData: null,
  ocrMatches: {},
  ocrReview: null,
  ocrReviewHighlights: {},
  ocrItemId: "",
  ocrLoadToken: 0,
  ocrProgress: 0,
  ocrProgressTimer: null,
  ocrPrefetchToken: 0,
  updateInfo: null,
  updatePollTimer: null
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
  "exportOpenActions", "openExportFileButton", "openExportFolderButton",
  "shortcutToolTab", "exportToolTab", "shortcutToolPanel", "exportToolPanel",
  "prevPageButton", "nextPageButton", "pageIndicator", "zoomOutButton", "zoomIndicator", "zoomInButton",
  "rotateButton", "downloadButton", "ocrToggleButton", "ocrStatus", "pdfPageSurface", "ocrOverlay",
  "pdfCanvas", "pdfLoading", "pdfEmpty", "pdfStage", "pdfThumbnails", "ocrReviewRail",
  "ocrReviewProgressText", "ocrReviewProgressBar", "ocrReviewList", "issuesDialog",
  "closeIssuesDialogButton", "schoolsDialog", "closeSchoolsDialogButton", "sourceList",
  "notesDialog", "closeNotesDialogButton", "notesEditor", "notesMessage", "saveNotesButton",
  "aboutProjectButton", "feedbackProjectButton", "aboutProjectDialog", "feedbackProjectDialog",
  "closeAboutProjectButton", "closeFeedbackProjectButton", "checkUpdateButton", "updateUnreadDot",
  "updateDialog", "updateDialogTitle", "updateVersionSummary", "updateChangelog",
  "updateDownloadActions", "downloadLatestButton", "closeUpdateDialogButton"
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
  return parts.at(-1) || "";
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

function setExportStatus(message, kind = "") {
  elements.exportStatus.textContent = message;
  elements.exportStatus.classList.toggle("working", kind === "working");
  elements.exportStatus.classList.toggle("success", kind === "success");
  elements.exportStatus.classList.toggle("error", kind === "error");
}

function setExportActionState(kind = "idle") {
  const labels = {
    idle: "回填当前学校",
    working: "正在生成副本...",
    attention: "请选择结果列",
    success: "✓ 回填成功",
    error: "✕ 回填失败"
  };
  state.exportActionState = kind;
  elements.writeBackExcelButton.textContent = labels[kind] || labels.idle;
  for (const stateName of ["working", "attention", "success", "error"]) {
    elements.writeBackExcelButton.classList.toggle(`export-${stateName}`, kind === stateName);
  }
}

function hideExportOpenActions() {
  state.lastExport = null;
  elements.exportOpenActions.hidden = true;
}

function updateExportPanel() {
  const school = getCurrentSchool();
  const schoolChanged = state.exportSchool !== school;
  if (schoolChanged) {
    state.exportSchool = school;
    state.exportExcelPath = "";
    elements.exportResultColumnSelect.hidden = true;
    hideExportOpenActions();
    setExportActionState("idle");
  }
  elements.exportSchoolLabel.textContent = school || "尚未选择学校";
  const source = state.sources.find((item) => item.school === school && item.active);
  if (state.exportActionState === "idle") {
    if (!school) setExportStatus("请先选择一所学校。");
    else if (source?.excelExists) setExportStatus("已找到该学校名单，将在原文件旁生成审核回填副本。");
    else setExportStatus("回填时请选择该学校的 Excel 名单，原文件不会被修改。");
  }
  elements.writeBackExcelButton.disabled = !school || state.exportActionState === "working";
}

async function writeBackCurrentSchool() {
  const school = getCurrentSchool();
  if (!school) return;
  if (!(await saveCurrentReview())) {
    setExportActionState("error");
    setExportStatus("回填失败：当前审核结果尚未保存成功。", "error");
    return;
  }
  elements.writeBackExcelButton.disabled = true;
  try {
    const source = state.sources.find((item) => item.school === school && item.active);
    let excelPath = state.exportExcelPath || source?.excelPath || "";
    if (!excelPath || source?.excelExists === false) {
      const picked = await api("/api/picker/excel", { method: "POST" });
      if (!picked.path) {
        setExportActionState("idle");
        setExportStatus("已取消选择 Excel，未生成任何文件。");
        return;
      }
      excelPath = picked.path;
      state.exportExcelPath = excelPath;
    }
    hideExportOpenActions();
    setExportActionState("working");
    setExportStatus("正在生成审核回填副本，原 Excel 文件保持不变...", "working");
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
      setExportActionState("attention");
      setExportStatus("检测到多个问题列，请选择要写入的列后再次回填。", "working");
      return;
    }
    if (payload.needsLayoutConfirmation) {
      setExportActionState("error");
      setExportStatus(`无法可靠识别名单布局：${(payload.layoutWarnings || []).join("；")}`, "error");
      return;
    }
    elements.exportResultColumnSelect.hidden = true;
    state.lastExport = { excelPath: payload.excelPath, folderPath: payload.folderPath };
    elements.exportOpenActions.hidden = false;
    const fileName = String(payload.excelPath || "").split(/[\\/]/).pop();
    setExportActionState("success");
    setExportStatus(`已生成副本：已审 ${payload.reviewed}，未审 ${payload.pending}，无 PDF ${payload.missing}，新增 ${payload.appended} 人。文件：${fileName}`, "success");
    await loadSources();
  } catch (error) {
    setExportActionState("error");
    setExportStatus(`回填失败：${error.message}`, "error");
  } finally {
    elements.writeBackExcelButton.disabled = !school;
  }
}

async function openExportPath(mode) {
  const target = mode === "folder" ? state.lastExport?.folderPath : state.lastExport?.excelPath;
  if (!target) return;
  try {
    await api("/api/open-path", {
      method: "POST",
      body: JSON.stringify({ path: target, mode })
    });
  } catch (error) {
    setExportStatus(`打开失败：${error.message}`, "error");
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
      elements.schoolNameInput.value = payload.suggestedSchool || suggestSchool(payload.path);
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

function compactExcelLayout(layout, confirmed = layout?.confirmed) {
  if (!layout?.sheet) return null;
  return {
    sheet: layout.sheet,
    headerRow: Number(layout.headerRow) || 1,
    nameColumn: Number(layout.nameColumn),
    resultColumn: Number(layout.resultColumn),
    confirmed: Boolean(confirmed)
  };
}

function analysisRowOverrides(analysis) {
  return Object.fromEntries(
    (analysis?.historyPreview || [])
      .filter((row) => row.sourceName && row.sourceName !== row.name)
      .map((row) => [String(row.rowNumber), { name: row.name }])
  );
}

function excelColumnLetter(index) {
  let value = Number(index) + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

async function analyzeImport(options = {}) {
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
    const analysis = await api("/api/import/analyze", {
      method: "POST",
      body: JSON.stringify({
        ...importPayload(),
        layout: options.layout || {},
        rowOverrides: options.rowOverrides || {}
      })
    });
    state.analysis = analysis;
    elements.schoolNameInput.value = analysis.school;
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
  detected.textContent = analysis.resultColumn ? `当前读取：${analysis.resultColumn}` : "当前不读取历史审核意见";
  heading.append(title, detected);

  const layout = analysis.excelLayout;
  const editor = document.createElement("div");
  editor.className = "excel-layout-editor";
  const createField = (labelText, control) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = labelText;
    label.append(caption, control);
    return label;
  };
  const sheetSelect = document.createElement("select");
  sheetSelect.dataset.layoutField = "sheet";
  for (const sheet of layout.sheets || []) {
    const option = document.createElement("option");
    option.value = sheet.name;
    option.textContent = `${sheet.name}（${sheet.rowCount} 行）`;
    sheetSelect.appendChild(option);
  }
  sheetSelect.value = layout.sheet;
  const headerRowInput = document.createElement("input");
  headerRowInput.type = "number";
  headerRowInput.min = "1";
  headerRowInput.value = String(layout.headerRow);
  headerRowInput.dataset.layoutField = "headerRow";
  headerRowInput.max = String((layout.sheets || []).find((item) => item.name === layout.sheet)?.rowCount || 1);
  const nameColumnSelect = document.createElement("select");
  nameColumnSelect.dataset.layoutField = "nameColumn";
  const resultColumnSelect = document.createElement("select");
  resultColumnSelect.dataset.layoutField = "resultColumn";

  const fillColumnChoices = () => {
    const sheet = (layout.sheets || []).find((item) => item.name === sheetSelect.value);
    const rowNumber = Number(headerRowInput.value) || 1;
    const rowValues = sheet?.rows?.find((row) => row.rowNumber === rowNumber)?.values || [];
    const fallbackColumns = sheetSelect.value === layout.sheet && rowNumber === layout.headerRow ? layout.columns : [];
    const count = Math.max(sheet?.columnCount || 0, rowValues.length, fallbackColumns.length);
    const currentName = nameColumnSelect.value || String(layout.nameColumn);
    const currentResult = resultColumnSelect.value || String(layout.resultColumn);
    nameColumnSelect.innerHTML = "";
    resultColumnSelect.innerHTML = '<option value="-1">不读取历史审核意见</option>';
    for (let index = 0; index < count; index += 1) {
      const fallback = fallbackColumns.find((item) => item.index === index);
      const header = rowValues[index] || fallback?.header || "未命名列";
      const letter = fallback?.letter || excelColumnLetter(index);
      for (const select of [nameColumnSelect, resultColumnSelect]) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${letter} 列 · ${header}`;
        select.appendChild(option);
      }
    }
    nameColumnSelect.value = currentName;
    resultColumnSelect.value = currentResult;
    if (!nameColumnSelect.value && nameColumnSelect.options.length) nameColumnSelect.selectedIndex = 0;
    if (!resultColumnSelect.value) resultColumnSelect.value = "-1";
  };
  fillColumnChoices();
  sheetSelect.addEventListener("change", () => {
    const sheet = (layout.sheets || []).find((item) => item.name === sheetSelect.value);
    headerRowInput.max = String(sheet?.rowCount || 1);
    fillColumnChoices();
  });
  headerRowInput.addEventListener("change", fillColumnChoices);
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  apply.textContent = "按此设置重新预览";
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    try {
      await analyzeImport({
        layout: {
          sheet: sheetSelect.value,
          headerRow: Number(headerRowInput.value),
          nameColumn: Number(nameColumnSelect.value),
          resultColumn: Number(resultColumnSelect.value),
          confirmed: true
        },
        rowOverrides: Object.fromEntries(
          [...elements.historyPreviewContainer.querySelectorAll("input[data-roster-row]")]
            .map((input) => [input.dataset.rosterRow, { name: input.value.trim() }])
        )
      });
    } finally {
      apply.disabled = false;
    }
  });
  editor.append(
    createField("工作表", sheetSelect),
    createField("表头所在行", headerRowInput),
    createField("姓名列", nameColumnSelect),
    createField("审核意见列", resultColumnSelect),
    apply
  );
  const layoutMessage = document.createElement("div");
  layoutMessage.className = `excel-layout-message${layout.needsConfirmation ? " error" : ""}`;
  layoutMessage.textContent = layout.warnings.length
    ? layout.warnings.join("；")
    : `已识别 ${layout.sheet}，第 ${layout.headerRow} 行表头，共 ${analysis.summary.rosterCount} 人。`;

  const table = document.createElement("table");
  table.className = "history-preview-table";
  table.innerHTML = "<thead><tr><th>姓名</th><th>问题</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const item of analysis.historyPreview || []) {
    const row = document.createElement("tr");
    if (item.suspicious) row.classList.add("suspicious");
    const name = document.createElement("td");
    if (item.suspicious) {
      const input = document.createElement("input");
      input.className = "history-name-correction";
      input.value = item.name;
      input.dataset.rosterRow = String(item.rowNumber);
      input.setAttribute("aria-label", `修正第 ${item.rowNumber} 行姓名`);
      const hint = document.createElement("small");
      hint.textContent = "修正后会同步写回 Excel";
      name.append(input, hint);
    } else name.textContent = item.name;
    const problem = document.createElement("td");
    problem.textContent = item.problem || "";
    row.append(name, problem);
    body.appendChild(row);
  }
  table.appendChild(body);
  elements.historyPreviewContainer.append(heading, editor, layoutMessage, table);
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
      const candidates = importCandidateNames(item);
      hint.textContent = `名单：${candidates.join("、")}`;
      copy.append(strong, hint);
      const decisionPanel = document.createElement("div");
      decisionPanel.className = "typo-decision-panel";
      let candidateSelect = null;
      if (candidates.length > 1) {
        const candidateControl = document.createElement("label");
        candidateControl.className = "typo-candidate-control";
        const candidateLabel = document.createElement("span");
        candidateLabel.textContent = "疑似对应的名单人员";
        candidateSelect = document.createElement("select");
        candidateSelect.innerHTML = `<option value="">请先选择人员</option>`;
        for (const candidate of candidates) {
          const option = document.createElement("option");
          option.value = candidate;
          option.textContent = candidate;
          candidateSelect.appendChild(option);
        }
        candidateControl.append(candidateLabel, candidateSelect);
        decisionPanel.appendChild(candidateControl);
      }
      const choices = document.createElement("div");
      choices.className = "typo-choice-list";
      const excelCorrect = document.createElement("button");
      excelCorrect.type = "button";
      excelCorrect.className = "typo-choice";
      const pdfCorrect = document.createElement("button");
      pdfCorrect.type = "button";
      pdfCorrect.className = "typo-choice";
      const keepBoth = document.createElement("button");
      keepBoth.type = "button";
      keepBoth.className = "typo-choice keep-both";
      keepBoth.dataset.bindingValue = "__append__";
      keepBoth.textContent = "并非同一人，保留两人";

      const currentCandidate = () => candidateSelect ? candidateSelect.value : candidates[0] || "";
      const updateCandidateChoices = () => {
        const candidate = currentCandidate();
        excelCorrect.disabled = !candidate;
        pdfCorrect.disabled = !candidate;
        excelCorrect.dataset.bindingValue = candidate ? `excel:${candidate}` : "";
        pdfCorrect.dataset.bindingValue = candidate ? `pdf:${candidate}` : "";
        excelCorrect.textContent = candidate ? `名单“${candidate}”正确` : "名单姓名正确";
        pdfCorrect.textContent = `PDF“${item.name}”正确`;
      };
      const choose = (button) => {
        if (!button.dataset.bindingValue) return;
        for (const sibling of choices.querySelectorAll(".typo-choice")) sibling.classList.remove("active");
        button.classList.add("active");
        row.dataset.bindingValue = button.dataset.bindingValue;
        choices.classList.remove("needs-attention");
        updateConfirmImportState();
      };
      for (const button of [excelCorrect, pdfCorrect, keepBoth]) {
        button.addEventListener("click", () => choose(button));
      }
      if (candidateSelect) {
        candidateSelect.addEventListener("change", () => {
          if (row.dataset.bindingValue !== "__append__") {
            row.dataset.bindingValue = "";
            excelCorrect.classList.remove("active");
            pdfCorrect.classList.remove("active");
          }
          updateCandidateChoices();
          updateConfirmImportState();
        });
      }
      const separator1 = document.createElement("span");
      separator1.className = "typo-choice-or";
      separator1.textContent = "or";
      const separator2 = separator1.cloneNode(true);
      choices.append(excelCorrect, separator1, pdfCorrect, separator2, keepBoth);
      updateCandidateChoices();
      const keepBothHint = document.createElement("div");
      keepBothHint.className = "hint typo-keep-both-hint";
      keepBothHint.textContent = "选择“保留两人”后，PDF 姓名会新增到 Excel，原名单人员不会被改名。";
      decisionPanel.append(choices, keepBothHint);
      const openPdf = document.createElement("button");
      openPdf.type = "button";
      openPdf.className = "small-button";
      openPdf.textContent = "打开 PDF 首页";
      openPdf.addEventListener("click", () => window.open(item.pdfPreviewUrl, "_blank", "noopener"));
      row.append(copy, decisionPanel, openPdf);
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
    ? state.analysis?.excelLayout?.needsConfirmation
      ? "自动识别不够可靠，请在上方修正设置并重新预览。"
      : "请确认姓名与问题两列识别正确。"
    : page === 2 ? "完成所有人员处理方案后才能导入。" : "名单核对报告已生成，可直接选择文字复制。";
  elements.analysisWizardMessage.classList.toggle("error", page === 1 && Boolean(state.analysis?.excelLayout?.needsConfirmation));
  elements.analysisNextButton.setAttribute("aria-disabled", String(page === 1 && Boolean(state.analysis?.excelLayout?.needsConfirmation)));
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
  const classification = classifyImportDecisions(analysis, bindings);
  const lines = ["只在名单出现，无入团申请书PDF"];
  lines.push(...(classification.onlyExcel.length ? classification.onlyExcel : ["无"]));
  lines.push("", "只有入团申请书PDF，未出现于名单中");
  lines.push(...(classification.onlyPdf.length ? classification.onlyPdf.map((item) => item.name) : ["无"]));
  lines.push("", "姓名登记存在错别字");
  if (!classification.typos.length) lines.push("无");
  for (const { item, binding: decision, excelName } of classification.typos) {
    const [source] = decision.split(":");
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
        layout: compactExcelLayout(state.analysis.excelLayout, true),
        rowOverrides: analysisRowOverrides(state.analysis),
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
    const content = line.replace(/^(?:第?[一二三四五六七八九十百\d]+[.．、])\s*/, "");
    for (const token of parseNoteMarkdown(content)) {
      if (token.type === "text") {
        item.appendChild(document.createTextNode(token.text));
        continue;
      }
      const segment = document.createElement(token.type === "strong" ? "strong" : "span");
      if (token.type === "alert") segment.className = "note-alert";
      segment.textContent = token.text;
      item.appendChild(segment);
    }
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

function showUtilityPanel(panel) {
  const showExport = panel === "export";
  elements.shortcutToolTab.classList.toggle("active", !showExport);
  elements.exportToolTab.classList.toggle("active", showExport);
  elements.shortcutToolTab.setAttribute("aria-selected", String(!showExport));
  elements.exportToolTab.setAttribute("aria-selected", String(showExport));
  elements.shortcutToolPanel.hidden = showExport;
  elements.exportToolPanel.hidden = !showExport;
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

function updateWasRead(version) {
  try {
    return localStorage.getItem(UPDATE_READ_KEY) === version;
  } catch {
    return false;
  }
}

function markUpdateRead(version) {
  try {
    localStorage.setItem(UPDATE_READ_KEY, version);
  } catch {}
}

function renderUpdateIndicator() {
  const info = state.updateInfo;
  const unread = Boolean(info?.status === "ready" && info.updateAvailable && !updateWasRead(info.latestVersion));
  elements.updateUnreadDot.hidden = !unread;
  elements.checkUpdateButton.title = info?.status === "ready"
    ? `当前版本 ${info.currentVersion}，最新版本 ${info.latestVersion}`
    : "检查软件更新";
}

function renderUpdateDialog() {
  const info = state.updateInfo;
  elements.updateChangelog.hidden = true;
  elements.updateDownloadActions.hidden = true;
  if (!info || info.status === "checking") {
    elements.updateDialogTitle.textContent = "检查更新";
    elements.updateVersionSummary.textContent = "正在检查更新...";
    return;
  }
  if (info.status === "error") {
    elements.updateDialogTitle.textContent = "暂时无法检查更新";
    elements.updateVersionSummary.textContent = info.error || "请稍后重试。";
    return;
  }
  if (!info.updateAvailable) {
    elements.updateDialogTitle.textContent = "已是最新版";
    elements.updateVersionSummary.textContent = `当前版本 v${info.currentVersion} 已是最新版。`;
    return;
  }
  elements.updateDialogTitle.textContent = `发现新版本 v${info.latestVersion}`;
  elements.updateVersionSummary.textContent = `当前版本 v${info.currentVersion}，最新版本 v${info.latestVersion}。`;
  elements.updateChangelog.textContent = info.changelog || "本次更新未提供更新日志。";
  elements.updateChangelog.hidden = false;
  elements.downloadLatestButton.href = info.releasesUrl || elements.downloadLatestButton.href;
  elements.updateDownloadActions.hidden = false;
}

async function loadUpdateInfo({ refresh = false, attempt = 0 } = {}) {
  try {
    const payload = await api(`/api/update${refresh ? "?refresh=1" : ""}`);
    state.updateInfo = payload;
    renderUpdateIndicator();
    if (elements.updateDialog.open) renderUpdateDialog();
    if (payload.status === "checking" && attempt < 15) {
      clearTimeout(state.updatePollTimer);
      state.updatePollTimer = setTimeout(() => loadUpdateInfo({ attempt: attempt + 1 }), 700);
    }
  } catch (error) {
    state.updateInfo = { status: "error", error: error.message };
    renderUpdateIndicator();
    if (elements.updateDialog.open) renderUpdateDialog();
  }
}

async function openUpdateDialog() {
  if (!elements.updateDialog.open) elements.updateDialog.showModal();
  if (state.updateInfo?.updateAvailable) {
    markUpdateRead(state.updateInfo.latestVersion);
    renderUpdateIndicator();
  }
  renderUpdateDialog();
  if (!state.updateInfo || state.updateInfo.status === "error") {
    state.updateInfo = { status: "checking" };
    renderUpdateDialog();
    await loadUpdateInfo({ refresh: true });
  }
}

const OCR_REVIEW_ORDER = ["age", "studyHours", "disciplineCourse", "declaration", "activist"];

function stopOcrProgress() {
  clearInterval(state.ocrProgressTimer);
  state.ocrProgressTimer = null;
}

function setOcrProgress(text, percent, working = false) {
  state.ocrProgress = Math.max(0, Math.min(100, percent));
  elements.ocrReviewProgressText.textContent = text;
  elements.ocrReviewProgressBar.style.width = `${state.ocrProgress}%`;
  elements.ocrReviewProgressBar.classList.toggle("working", working);
}

function startOcrProgress(pageCount) {
  stopOcrProgress();
  setOcrProgress(`识别 0/${pageCount || "?"} 页`, 6, true);
  state.ocrProgressTimer = setInterval(() => {
    if (state.ocrProgress >= 68) return;
    const next = Math.min(68, state.ocrProgress + Math.max(1, Math.round((68 - state.ocrProgress) * 0.08)));
    const estimatedPage = pageCount ? Math.min(pageCount - 1, Math.floor((next / 70) * pageCount)) : "?";
    setOcrProgress(`识别 ${estimatedPage}/${pageCount || "?"} 页`, next, true);
  }, 550);
}

function renderOcrReviewRail() {
  elements.ocrReviewList.innerHTML = "";
  const checks = state.ocrReview?.checks;
  for (const key of OCR_REVIEW_ORDER) {
    const check = checks?.[key] || { label: {
      age: "年龄门槛",
      studyHours: "团课学时",
      disciplineCourse: "团纪处分条例",
      declaration: "信仰声明",
      activist: "积极分子"
    }[key], status: "pending", detail: state.ocrEnabled ? "等待识别" : "OCR 已关闭", page: null };
    const item = document.createElement("div");
    item.className = `ocr-review-item ${check.status}`;
    item.dataset.checkKey = key;
    const main = document.createElement("div");
    main.className = "ocr-review-main";
    const titleRow = document.createElement("div");
    titleRow.className = "ocr-review-title-row";
    const icon = document.createElement("span");
    icon.className = "ocr-review-icon";
    icon.textContent = { pass: "✓", fail: "!", pending: "?" }[check.status] || "·";
    const label = document.createElement("span");
    label.className = "ocr-review-label";
    label.textContent = check.label;
    const detail = document.createElement("span");
    detail.className = "ocr-review-detail";
    detail.textContent = check.detail;
    if (key === "age" && check.status === "pass") detail.classList.add("emphasis");
    titleRow.append(icon, label);
    main.append(titleRow, detail);
    const actions = document.createElement("div");
    actions.className = "ocr-review-actions";
    if (check.status === "fail" && check.reviewText) {
      const insertButton = document.createElement("button");
      insertButton.type = "button";
      insertButton.className = "ocr-review-action insert";
      insertButton.textContent = "+";
      insertButton.title = "插入到审核结果";
      insertButton.addEventListener("click", () => insertOcrReviewIssue(check.reviewText));
      actions.appendChild(insertButton);
    }
    const targets = Array.isArray(check.jumpTargets) && check.jumpTargets.length
      ? check.jumpTargets
      : check.page ? [{ label: "查看", page: check.page, focus: check.focus }] : [];
    for (const target of targets) {
      const jumpButton = document.createElement("button");
      jumpButton.type = "button";
      jumpButton.className = "ocr-review-action jump";
      jumpButton.textContent = `↗ ${target.label}`;
      jumpButton.title = `跳转到${target.label}（第 ${target.page} 页）`;
      jumpButton.addEventListener("click", () => jumpToOcrReviewTarget(target));
      actions.appendChild(jumpButton);
    }
    item.append(main, actions);
    elements.ocrReviewList.appendChild(item);
  }
}

function insertOcrReviewIssue(text) {
  const issue = String(text || "").trim();
  if (!issue || !state.currentReviewId) return;
  if (elements.reviewText.value.includes(issue)) {
    elements.reviewText.focus();
    setSaveStatus("该问题已在审核结果中");
    return;
  }
  const end = elements.reviewText.value.length;
  elements.reviewText.setSelectionRange(end, end);
  insertAtCursor(issue);
}

async function jumpToOcrReviewTarget(target) {
  if (!target?.page || !state.pdfDocument) return;
  if (state.pdfPage !== target.page) state.pdfPageChanged = true;
  state.pdfPage = target.page;
  await renderPdfPage();
  if (!target.focus) return;
  const page = (state.ocrData?.pages || []).find((entry) => Number(entry.page) === target.page);
  if (!page) return;
  const viewportWidth = Number.parseFloat(elements.pdfCanvas.style.width) || elements.pdfCanvas.clientWidth;
  const viewportHeight = Number.parseFloat(elements.pdfCanvas.style.height) || elements.pdfCanvas.clientHeight;
  const box = transformOcrBox(target.focus, page.width, page.height, viewportWidth, viewportHeight, state.pdfRotation);
  elements.pdfStage.scrollTo({ top: Math.max(0, box.top - 90), behavior: "smooth" });
}

function resetOcrState(itemId = "") {
  stopOcrProgress();
  state.ocrData = null;
  state.ocrMatches = {};
  state.ocrReview = null;
  state.ocrReviewHighlights = {};
  state.ocrItemId = itemId;
  state.ocrLoadToken += 1;
  state.ocrPrefetchToken += 1;
  elements.ocrOverlay.innerHTML = "";
  elements.ocrStatus.textContent = itemId ? "OCR 识别中" : "OCR 等待中";
  setOcrProgress(itemId ? "准备识别" : "等待资料", 0, Boolean(itemId));
  renderOcrReviewRail();
}

function renderOcrHighlights() {
  elements.ocrOverlay.innerHTML = "";
  if (!state.ocrEnabled || !state.ocrData || !state.pdfPage || elements.pdfPageSurface.hidden) return;
  const page = (state.ocrData.pages || []).find((entry) => Number(entry.page) === state.pdfPage);
  const matches = [
    ...(state.ocrMatches[state.pdfPage] || []),
    ...(state.ocrReviewHighlights[state.pdfPage] || [])
  ];
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
      highlight.className = `ocr-highlight${match.kind ? ` ${match.kind}` : ""}`;
      highlight.title = match.kind
        ? match.target
        : `${match.target}（疑似匹配 ${Math.round(match.score * 100)}%）`;
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
  const prefetchToken = state.ocrPrefetchToken;
  if (!state.ocrEnabled || !item?.hasPdf) return;
  elements.ocrStatus.textContent = "OCR 识别中";
  startOcrProgress(state.pdfDocument?.numPages || 0);
  try {
    const payload = await api(`/api/ocr/${encodeURIComponent(item.id)}`);
    if (!state.ocrEnabled || pdfLoadToken !== state.pdfLoadToken || ocrLoadToken !== state.ocrLoadToken || state.ocrItemId !== item.id) return;
    stopOcrProgress();
    setOcrProgress("定位页面", 76, true);
    state.ocrData = payload;
    state.ocrMatches = findDocumentOcrMatches(payload);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    setOcrProgress("核对日期", 88, true);
    state.ocrReview = analyzeOcrReview(payload, state.ocrMatches);
    state.ocrReviewHighlights = state.ocrReview.highlights || {};
    renderOcrReviewRail();
    const totalMatches = Object.values(state.ocrMatches).reduce((sum, matches) => sum + matches.length, 0);
    elements.ocrStatus.textContent = totalMatches ? `共标注 ${totalMatches} 处` : "未找到可靠匹配";
    setOcrProgress(`${OCR_REVIEW_ORDER.length} 项完成`, 100, false);
    renderOcrHighlights();
    void prefetchUpcomingOcr(item, prefetchToken);
  } catch (error) {
    if (pdfLoadToken !== state.pdfLoadToken || ocrLoadToken !== state.ocrLoadToken) return;
    stopOcrProgress();
    elements.ocrStatus.textContent = "OCR 不可用";
    elements.ocrStatus.title = error.message;
    setOcrProgress("识别失败", 100, false);
    renderOcrReviewRail();
  }
}

async function prefetchUpcomingOcr(currentItem, token) {
  if (!state.ocrEnabled || token !== state.ocrPrefetchToken) return;
  const filtered = getFilteredItems();
  const currentIndex = filtered.findIndex((item) => item.id === currentItem?.id);
  if (currentIndex < 0) return;
  const candidates = filtered.slice(currentIndex + 1).filter((item) => item.hasPdf).slice(0, 2);
  for (const candidate of candidates) {
    if (!state.ocrEnabled || token !== state.ocrPrefetchToken) return;
    try {
      await api(`/api/ocr/${encodeURIComponent(candidate.id)}`);
    } catch {}
  }
}

function applyServerPdfThumbnails(payload, pdfDocument, loadToken) {
  if (
    !Array.isArray(payload?.pages) || payload.pages.length !== pdfDocument.numPages ||
    loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument
  ) return false;
  state.pdfThumbnailObserver?.disconnect();
  state.pdfThumbnailObserver = null;
  state.pdfThumbnailQueue?.clear();
  let fallbackStarted = false;
  const startFallback = () => {
    if (fallbackStarted || loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument) return;
    fallbackStarted = true;
    observePdfThumbnails(pdfDocument, loadToken);
  };
  for (const pageInfo of payload.pages) {
    const button = elements.pdfThumbnails.querySelector(`.pdf-thumbnail[data-page="${pageInfo.page}"]`);
    if (!button || button.dataset.thumbnailState === "rendered") continue;
    button.dataset.thumbnailState = "loading";
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument || !button.isConnected) return;
      const canvas = button.querySelector("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0);
      button.dataset.thumbnailState = "rendered";
      button.dataset.thumbnailSource = "cache";
    };
    image.onerror = () => {
      if (button.dataset.thumbnailState === "loading") button.dataset.thumbnailState = "empty";
      startFallback();
    };
    image.src = pageInfo.url;
  }
  return true;
}

function startPdfThumbnailLoading(pdfDocument, loadToken, manifestPromise) {
  let fallbackStarted = false;
  const startFallback = () => {
    if (fallbackStarted || loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument) return;
    fallbackStarted = true;
    observePdfThumbnails(pdfDocument, loadToken);
  };
  const fallbackTimer = window.setTimeout(startFallback, 900);
  manifestPromise.then((payload) => {
    window.clearTimeout(fallbackTimer);
    if (!applyServerPdfThumbnails(payload, pdfDocument, loadToken)) startFallback();
  });
}

async function loadPdf(item) {
  state.pdfReviewStartedAt = 0;
  state.pdfPageChanged = false;
  const loadToken = ++state.pdfLoadToken;
  resetPdfThumbnails();
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  if (state.pdfLoadingTask) await state.pdfLoadingTask.destroy().catch(() => {});
  state.pdfLoadingTask = null;
  if (state.pdfDocument) await state.pdfDocument.destroy().catch(() => {});
  state.pdfDocument = null;
  state.pdfPage = 0;
  state.pdfScale = 1;
  state.pdfRotation = 0;
  state.pdfAutoFit = true;
  resetOcrState(item?.id || "");
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
  const thumbnailManifestPromise = api(`/api/pdf-thumbnails/${encodeURIComponent(item.id)}`).catch(() => null);
  try {
    const loadingTask = pdfjsLib.getDocument(`/api/pdf/${encodeURIComponent(item.id)}`);
    state.pdfLoadingTask = loadingTask;
    const pdfDocument = await loadingTask.promise;
    if (loadToken !== state.pdfLoadToken) {
      await pdfDocument.destroy().catch(() => {});
      return;
    }
    state.pdfLoadingTask = null;
    state.pdfDocument = pdfDocument;
    state.pdfPage = 1;
    buildPdfThumbnailSlots(pdfDocument, loadToken);
    await renderPdfPage({ fit: true });
    startPdfThumbnailLoading(pdfDocument, loadToken, thumbnailManifestPromise);
    state.pdfReviewStartedAt = Date.now();
    loadOcrHighlights(item, loadToken);
  } catch (error) {
    if (loadToken !== state.pdfLoadToken) return;
    elements.pdfEmpty.hidden = false;
    elements.pdfEmpty.textContent = `资料打开失败：${error.message}`;
  } finally {
    if (loadToken === state.pdfLoadToken) elements.pdfLoading.hidden = true;
  }
}

function fitPdfScale(page) {
  const baseViewport = page.getViewport({ scale: 1, rotation: state.pdfRotation });
  return calculateContainedPdfScale({
    pageWidth: baseViewport.width,
    pageHeight: baseViewport.height,
    containerWidth: elements.pdfStage.clientWidth,
    containerHeight: elements.pdfStage.clientHeight,
    padding: 20
  });
}

async function renderPdfPage({ fit = false } = {}) {
  if (!state.pdfDocument || !state.pdfPage) return;
  const renderToken = ++state.pdfPageRenderToken;
  const pdfDocument = state.pdfDocument;
  const pageNumber = state.pdfPage;
  state.pdfMainRendering = true;
  state.pdfThumbnailQueue?.cancelActive();
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  try {
    const page = await pdfDocument.getPage(pageNumber);
    if (renderToken !== state.pdfPageRenderToken || pdfDocument !== state.pdfDocument) return;
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
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    });
    state.pdfRenderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      throw error;
    } finally {
      if (state.pdfRenderTask === renderTask) state.pdfRenderTask = null;
    }
    if (renderToken !== state.pdfPageRenderToken || pdfDocument !== state.pdfDocument) return;
    paintActiveThumbnailFromMain(pageNumber);
    queueVisiblePdfThumbnails();
    renderOcrHighlights();
    elements.pdfStage.scrollTo({ top: 0, behavior: "auto" });
    updateActiveThumbnail();
    updatePdfControls();
  } finally {
    if (renderToken === state.pdfPageRenderToken) state.pdfMainRendering = false;
  }
}

function updateActiveThumbnail() {
  for (const button of elements.pdfThumbnails.querySelectorAll(".pdf-thumbnail")) {
    const active = Number(button.dataset.page) === state.pdfPage;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
    if (active) button.scrollIntoView({ block: "nearest" });
  }
}

function scheduleThumbnailRender(callback) {
  if ("requestIdleCallback" in window) {
    return window.requestIdleCallback(callback, { timeout: 700 });
  }
  return window.setTimeout(callback, 32);
}

function cancelScheduledThumbnailRender(handle) {
  if ("cancelIdleCallback" in window) window.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}

function ensurePdfThumbnailQueue() {
  if (state.pdfThumbnailQueue) return state.pdfThumbnailQueue;
  state.pdfThumbnailQueue = createThumbnailRenderQueue({
    schedule: scheduleThumbnailRender,
    cancelScheduled: cancelScheduledThumbnailRender,
    run: renderQueuedPdfThumbnail,
    onError: (error) => console.warn("缩略图生成失败", error)
  });
  return state.pdfThumbnailQueue;
}

function resetPdfThumbnails() {
  state.pdfThumbnailObserver?.disconnect();
  state.pdfThumbnailObserver = null;
  state.pdfThumbnailQueue?.clear();
  elements.pdfThumbnails.innerHTML = "";
}

function thumbnailKey(loadToken, pageNumber) {
  return `${loadToken}:${pageNumber}`;
}

function buildPdfThumbnailSlots(pdfDocument, loadToken) {
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pdf-thumbnail";
    button.dataset.page = String(pageNumber);
    button.dataset.loadToken = String(loadToken);
    button.dataset.thumbnailState = "empty";
    button.title = `第 ${pageNumber} 页`;
    const canvas = document.createElement("canvas");
    canvas.width = 168;
    canvas.height = 224;
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
}

function observePdfThumbnails(pdfDocument, loadToken) {
  if (!("IntersectionObserver" in window)) {
    for (const button of [...elements.pdfThumbnails.querySelectorAll(".pdf-thumbnail")].slice(0, 4)) {
      button.dataset.thumbnailVisible = "true";
      queuePdfThumbnail(button, pdfDocument, loadToken);
    }
    return;
  }
  state.pdfThumbnailObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const button = entry.target;
      button.dataset.thumbnailVisible = String(entry.isIntersecting);
      if (entry.isIntersecting) queuePdfThumbnail(button, pdfDocument, loadToken);
    }
  }, {
    root: elements.pdfThumbnails,
    rootMargin: "320px 0px",
    threshold: 0.01
  });
  for (const button of elements.pdfThumbnails.querySelectorAll(".pdf-thumbnail")) {
    state.pdfThumbnailObserver.observe(button);
  }
}

function queuePdfThumbnail(button, pdfDocument = state.pdfDocument, loadToken = state.pdfLoadToken) {
  if (
    !button || button.dataset.thumbnailState !== "empty" ||
    loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument
  ) return;
  const pageNumber = Number(button.dataset.page);
  button.dataset.thumbnailState = "queued";
  ensurePdfThumbnailQueue().enqueue(
    thumbnailKey(loadToken, pageNumber),
    { button, pdfDocument, loadToken, pageNumber },
    pageNumber === state.pdfPage ? 10 : 0
  );
}

function queueVisiblePdfThumbnails() {
  for (const button of elements.pdfThumbnails.querySelectorAll('.pdf-thumbnail[data-thumbnail-visible="true"]')) {
    queuePdfThumbnail(button);
  }
}

function paintThumbnailCanvas(button, sourceCanvas) {
  if (!button || !sourceCanvas?.width || !sourceCanvas?.height) return false;
  const scale = Math.min(168 / sourceCanvas.width, 224 / sourceCanvas.height);
  const canvas = button.querySelector("canvas");
  canvas.width = Math.max(1, Math.floor(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.floor(sourceCanvas.height * scale));
  canvas.getContext("2d", { alpha: false }).drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  button.dataset.thumbnailState = "rendered";
  state.pdfThumbnailObserver?.unobserve(button);
  return true;
}

function paintActiveThumbnailFromMain(pageNumber = state.pdfPage) {
  const button = elements.pdfThumbnails.querySelector(`.pdf-thumbnail[data-page="${pageNumber}"]`);
  if (!button || button.dataset.thumbnailState === "rendered") return;
  state.pdfThumbnailQueue?.remove(thumbnailKey(state.pdfLoadToken, pageNumber));
  paintThumbnailCanvas(button, elements.pdfCanvas);
}

async function renderQueuedPdfThumbnail({ button, pdfDocument, loadToken, pageNumber }, signal) {
  if (
    signal.aborted || loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument ||
    button.dataset.thumbnailState === "rendered"
  ) return;
  if (state.pdfMainRendering) {
    button.dataset.thumbnailState = "empty";
    return;
  }
  button.dataset.thumbnailState = "rendering";
  try {
    if (pageNumber === state.pdfPage && paintThumbnailCanvas(button, elements.pdfCanvas)) return;
    const page = await pdfDocument.getPage(pageNumber);
    if (signal.aborted || loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(168 / baseViewport.width, 224 / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = button.querySelector("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
    const cancelRender = () => renderTask.cancel();
    signal.addEventListener("abort", cancelRender, { once: true });
    try {
      await renderTask.promise;
      if (signal.aborted || loadToken !== state.pdfLoadToken || pdfDocument !== state.pdfDocument) return;
      button.dataset.thumbnailState = "rendered";
      state.pdfThumbnailObserver?.unobserve(button);
    } finally {
      signal.removeEventListener("abort", cancelRender);
    }
  } catch (error) {
    if (!signal.aborted && error?.name !== "RenderingCancelledException") throw error;
  } finally {
    if (button.dataset.thumbnailState === "rendering") button.dataset.thumbnailState = "empty";
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
  elements.analysisNextButton.addEventListener("click", () => {
    if (elements.analysisNextButton.getAttribute("aria-disabled") === "true") {
      elements.analysisWizardMessage.textContent = "请先修正并应用 Excel 读取设置。";
      elements.analysisWizardMessage.classList.add("error");
      elements.historyPreviewContainer.querySelector(".excel-layout-editor")?.classList.add("needs-attention");
      return;
    }
    showAnalysisPage(2);
  });
  elements.analysisBackButton.addEventListener("click", () => showAnalysisPage(1));
  elements.confirmImportButton.addEventListener("click", commitImport);
  elements.finishAnalysisButton.addEventListener("click", () => {
    elements.issuesDialog.close();
    state.analysis = null;
    state.importResult = null;
    showImportStep(1);
  });
  elements.shortcutToolTab.addEventListener("click", () => showUtilityPanel("shortcuts"));
  elements.exportToolTab.addEventListener("click", () => showUtilityPanel("export"));
  elements.exportResultColumnSelect.addEventListener("change", () => {
    setExportActionState("idle");
    setExportStatus(`将写入“${elements.exportResultColumnSelect.value}”列，点击按钮生成副本。`);
  });
  elements.writeBackExcelButton.addEventListener("click", writeBackCurrentSchool);
  elements.openExportFileButton.addEventListener("click", () => openExportPath("file"));
  elements.openExportFolderButton.addEventListener("click", () => openExportPath("folder"));
  elements.ocrToggleButton.addEventListener("click", () => {
    state.ocrEnabled = !state.ocrEnabled;
    elements.ocrToggleButton.classList.toggle("active", state.ocrEnabled);
    elements.ocrToggleButton.setAttribute("aria-pressed", String(state.ocrEnabled));
    elements.ocrToggleButton.setAttribute("aria-checked", String(state.ocrEnabled));
    if (!state.ocrEnabled) {
      stopOcrProgress();
      elements.ocrOverlay.innerHTML = "";
      elements.ocrStatus.textContent = "OCR 已关闭";
      setOcrProgress("已关闭", 0, false);
      renderOcrReviewRail();
      return;
    }
    const item = state.items[state.currentIndex];
    if (state.ocrData) {
      renderOcrHighlights();
      renderOcrReviewRail();
      setOcrProgress(`${OCR_REVIEW_ORDER.length} 项完成`, 100, false);
    }
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
  elements.aboutProjectButton.addEventListener("click", () => elements.aboutProjectDialog.showModal());
  elements.feedbackProjectButton.addEventListener("click", () => elements.feedbackProjectDialog.showModal());
  elements.closeAboutProjectButton.addEventListener("click", () => elements.aboutProjectDialog.close());
  elements.closeFeedbackProjectButton.addEventListener("click", () => elements.feedbackProjectDialog.close());
  elements.checkUpdateButton.addEventListener("click", openUpdateDialog);
  elements.closeUpdateDialogButton.addEventListener("click", () => elements.updateDialog.close());

  elements.prevPageButton.addEventListener("click", () => movePdfPage(-1));
  elements.nextPageButton.addEventListener("click", () => movePdfPage(1));
  elements.zoomOutButton.addEventListener("click", () => changeZoom(-0.15));
  elements.zoomInButton.addEventListener("click", () => changeZoom(0.15));
  elements.rotateButton.addEventListener("click", rotatePdf);
  elements.downloadButton.addEventListener("click", () => {
    if (state.currentReviewId) window.open(`/api/pdf/${encodeURIComponent(state.currentReviewId)}/download`, "_blank", "noopener");
  });

  window.addEventListener("keydown", (event) => {
    const pageOffset = {
      PageDown: 1,
      ArrowDown: 1,
      PageUp: -1,
      ArrowUp: -1
    }[event.code];
    if (pageOffset) {
      event.preventDefault();
      event.stopImmediatePropagation();
      movePdfPage(pageOffset);
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
  void loadUpdateInfo();
  await loadSources();
  await loadBootstrapData();
}

bootstrap().catch((error) => {
  elements.studentTitle.textContent = "加载失败";
  elements.studentMeta.textContent = error.message;
  setSaveStatus("无法初始化");
});
