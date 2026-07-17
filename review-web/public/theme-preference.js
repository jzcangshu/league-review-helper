export const THEME_STORAGE_KEY = "review-color-theme-v1";

export function normalizeTheme(value) {
  return value === "dark" || value === "light" ? value : null;
}

export function resolveTheme(savedTheme, prefersDark = false) {
  return normalizeTheme(savedTheme) || (prefersDark ? "dark" : "light");
}

export function oppositeTheme(theme) {
  return theme === "dark" ? "light" : "dark";
}
