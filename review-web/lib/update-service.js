const https = require("node:https");

const UPDATE_URL = "https://raw.giteeusercontent.com/jzcangshu/league-review-helper/raw/master/latest_version.txt";
const RELEASES_URL = "https://github.com/jzcangshu/league-review-helper/releases/latest";

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("版本号格式应为 x.y.z。");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function parseUpdateText(value) {
  const lines = String(value || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const latestVersion = String(lines.shift() || "").trim();
  if (!parseVersion(latestVersion)) throw new Error("远端版本号格式不正确。");
  const changelog = lines.join("\n").trim();
  return { latestVersion: latestVersion.replace(/^v/i, ""), changelog };
}

function fetchText(url, options = {}) {
  const timeout = options.timeout || 10000;
  const request = options.request || https.get;
  const redirects = options.redirects ?? 3;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        "User-Agent": `league-review-helper/${options.currentVersion || "unknown"}`,
        Accept: "text/plain"
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) {
          reject(new Error("更新地址重定向次数过多。"));
          return;
        }
        fetchText(new URL(response.headers.location, url).toString(), { ...options, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`更新服务器返回 HTTP ${response.statusCode || "未知"}。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 128 * 1024) req.destroy(new Error("更新信息文件过大。"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(timeout, () => req.destroy(new Error("检查更新超时。")));
    req.on("error", reject);
  });
}

async function checkForUpdates(options) {
  const currentVersion = String(options.currentVersion || "").trim();
  if (!parseVersion(currentVersion)) throw new Error("本地版本号格式不正确。");
  const text = options.text ?? await fetchText(options.url || UPDATE_URL, {
    currentVersion,
    timeout: options.timeout,
    request: options.request
  });
  const remote = parseUpdateText(text);
  return {
    currentVersion,
    latestVersion: remote.latestVersion,
    changelog: remote.changelog,
    updateAvailable: compareVersions(currentVersion, remote.latestVersion) < 0,
    releasesUrl: RELEASES_URL,
    checkedAt: new Date().toISOString()
  };
}

module.exports = { UPDATE_URL, RELEASES_URL, checkForUpdates, compareVersions, fetchText, parseUpdateText, parseVersion };
