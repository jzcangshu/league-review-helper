import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTheme, oppositeTheme, resolveTheme } from "../public/theme-preference.js";

test("saved light or dark theme takes priority over system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("first launch follows the system color preference", () => {
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme("unknown", false), "light");
});

test("theme toggle always switches between light and dark", () => {
  assert.equal(oppositeTheme("light"), "dark");
  assert.equal(oppositeTheme("dark"), "light");
  assert.equal(normalizeTheme("sepia"), null);
});
