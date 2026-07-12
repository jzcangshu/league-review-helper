const fsp = require("node:fs/promises");
const path = require("node:path");

const STATUS_FILE = ".review-status.json";

function statusPath(reviewDir) {
  return path.join(reviewDir, STATUS_FILE);
}

async function loadReviewStatus(reviewDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(statusPath(reviewDir), "utf8"));
    const reviewed = parsed?.reviewed && typeof parsed.reviewed === "object" ? parsed.reviewed : {};
    return { version: 1, reviewed };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, reviewed: {} };
    if (error instanceof SyntaxError) throw new Error(`审核状态文件格式损坏：${statusPath(reviewDir)}`);
    throw error;
  }
}

async function setReviewed(reviewDir, studentName, reviewed) {
  const status = await loadReviewStatus(reviewDir);
  if (reviewed) {
    status.reviewed[studentName] = { reviewedAt: new Date().toISOString() };
  } else {
    delete status.reviewed[studentName];
  }
  await fsp.mkdir(reviewDir, { recursive: true });
  await fsp.writeFile(statusPath(reviewDir), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return Boolean(status.reviewed[studentName]);
}

async function renameReviewedName(reviewDir, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const status = await loadReviewStatus(reviewDir);
  if (!status.reviewed[oldName]) return;
  status.reviewed[newName] ||= status.reviewed[oldName];
  delete status.reviewed[oldName];
  await fsp.writeFile(statusPath(reviewDir), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function isExplicitlyReviewed(status, studentName) {
  return Boolean(status?.reviewed?.[studentName]);
}

module.exports = { STATUS_FILE, isExplicitlyReviewed, loadReviewStatus, renameReviewedName, setReviewed, statusPath };
