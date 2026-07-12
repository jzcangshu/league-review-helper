export function shouldAutoMarkReviewed({ reviewed, hasPdf, pageChanged, startedAt, now = Date.now(), minimumMs = 10000 }) {
  return Boolean(!reviewed && hasPdf && pageChanged && startedAt && now - startedAt >= minimumMs);
}
