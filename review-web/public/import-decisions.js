export function importCandidateNames(item) {
  const values = item.excelName ? [item.excelName] : item.matchCandidates || [];
  return [...new Set(values.filter(Boolean))];
}

function selectedRosterName(binding) {
  const value = String(binding || "").trim();
  const correction = value.match(/^(?:excel|pdf):(.+)$/);
  if (correction) return correction[1];
  if (value && !value.startsWith("__")) return value;
  return "";
}

export function classifyImportDecisions(analysis, bindings = {}) {
  const matchedRosterNames = new Set();
  const onlyPdf = [];
  const typos = [];

  for (const item of analysis.items || []) {
    if (item.matchKind === "exact") {
      if (item.excelName) matchedRosterNames.add(item.excelName);
      continue;
    }

    const binding = String(bindings[item.name] || "").trim();
    const rosterName = selectedRosterName(binding);
    if (rosterName) matchedRosterNames.add(rosterName);

    if (item.matchKind === "fuzzy" || item.matchKind === "ambiguous") {
      if (binding === "__append__") onlyPdf.push(item);
      else if (rosterName) typos.push({ item, binding, excelName: rosterName });
      continue;
    }

    if (!rosterName) onlyPdf.push(item);
  }

  return {
    onlyExcel: (analysis.rosterNames || []).filter((name) => !matchedRosterNames.has(name)),
    onlyPdf,
    typos
  };
}
