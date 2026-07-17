export function calculateContainedPdfScale({
  pageWidth,
  pageHeight,
  containerWidth,
  containerHeight,
  padding = 20
}) {
  const width = Number(pageWidth);
  const height = Number(pageHeight);
  const availableWidth = Math.max(1, Number(containerWidth) - padding);
  const availableHeight = Math.max(1, Number(containerHeight) - padding);
  if (!(width > 0) || !(height > 0)) return 1;

  return Math.min(availableWidth / width, availableHeight / height);
}
