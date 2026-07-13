import assert from "node:assert/strict";
import test from "node:test";

import { parseNoteMarkdown } from "../public/note-markdown.js";

test("note markdown turns Chinese brackets and Markdown bold into strong text", () => {
  assert.deepEqual(parseNoteMarkdown("基本信息完整+【有照片】，且 **日期正确**"), [
    { type: "text", text: "基本信息完整+" },
    { type: "strong", text: "有照片" },
    { type: "text", text: "，且 " },
    { type: "strong", text: "日期正确" }
  ]);
});

test("note markdown renders italic markers as red alert text instead of italics", () => {
  assert.deepEqual(parseNoteMarkdown("丨*OCR会帮你判断*"), [
    { type: "text", text: "丨" },
    { type: "alert", text: "OCR会帮你判断" }
  ]);
});

test("note markdown keeps markup-like HTML as plain text tokens", () => {
  assert.deepEqual(parseNoteMarkdown("<img src=x>【必须盖章】"), [
    { type: "text", text: "<img src=x>" },
    { type: "strong", text: "必须盖章" }
  ]);
});
