export function parseNoteMarkdown(value) {
  const text = String(value || "");
  const tokens = [];
  const pattern = /(【([^】]+)】|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) tokens.push({ type: "text", text: text.slice(offset, match.index) });
    if (match[2] || match[3] || match[4]) {
      tokens.push({ type: "strong", text: match[2] || match[3] || match[4] });
    } else {
      tokens.push({ type: "alert", text: match[5] || match[6] });
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) tokens.push({ type: "text", text: text.slice(offset) });
  return tokens.length ? tokens : [{ type: "text", text }];
}
