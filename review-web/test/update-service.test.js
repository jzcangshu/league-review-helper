const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { checkForUpdates, compareVersions, parseUpdateText } = require("../lib/update-service");

test("semantic version comparison handles numeric components", () => {
  assert.equal(compareVersions("1.1.1", "1.1.2"), -1);
  assert.equal(compareVersions("1.10.0", "1.2.9"), 1);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
});

test("update text uses the first line as version and preserves later changelog lines", () => {
  assert.deepEqual(parseUpdateText("1.1.2\r\n第一行更新内容\r\n第二行更新内容\r\n"), {
    latestVersion: "1.1.2",
    changelog: "第一行更新内容\n第二行更新内容"
  });
});

test("update check reports newer, equal and older remote versions correctly", async () => {
  assert.equal((await checkForUpdates({ currentVersion: "1.1.1", text: "1.1.2\n更新" })).updateAvailable, true);
  assert.equal((await checkForUpdates({ currentVersion: "1.1.2", text: "1.1.2\n更新" })).updateAvailable, false);
  assert.equal((await checkForUpdates({ currentVersion: "1.1.3", text: "1.1.2\n更新" })).updateAvailable, false);
});

test("invalid remote version is rejected instead of treated as an update", async () => {
  await assert.rejects(
    checkForUpdates({ currentVersion: "1.1.1", text: "最新版\n更新内容" }),
    /版本号格式/
  );
});

test("network failures are reported without inventing update information", async () => {
  const request = () => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    process.nextTick(() => req.emit("error", new Error("offline")));
    return req;
  };
  await assert.rejects(
    checkForUpdates({ currentVersion: "1.1.2", request }),
    /offline/
  );
});
