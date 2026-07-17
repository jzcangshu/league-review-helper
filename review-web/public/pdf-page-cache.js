export function createPdfPageCache({ maxEntries = 4 } = {}) {
  const entries = new Map();
  const limit = Math.max(1, Number(maxEntries) || 1);

  return {
    get(key) {
      if (!entries.has(key)) return null;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return value;
    },
    has(key) {
      return entries.has(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}

export function pdfPageRenderKey({ loadToken, pageNumber, rotation, scale, outputScale }) {
  return [
    Number(loadToken) || 0,
    Number(pageNumber) || 0,
    Number(rotation) || 0,
    Number(scale || 0).toFixed(4),
    Number(outputScale || 1).toFixed(2)
  ].join(":");
}
