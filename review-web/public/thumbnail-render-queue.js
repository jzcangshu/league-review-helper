export function createThumbnailRenderQueue({ run, schedule, cancelScheduled, onError = () => {} }) {
  const pending = new Map();
  let order = 0;
  let scheduledHandle = null;
  let active = null;

  function nextEntry() {
    return [...pending.values()].sort((left, right) =>
      right.priority - left.priority || left.order - right.order
    )[0] || null;
  }

  function requestDrain() {
    if (scheduledHandle !== null || active || !pending.size) return;
    scheduledHandle = schedule(async () => {
      scheduledHandle = null;
      if (active) return;
      const entry = nextEntry();
      if (!entry) return;
      pending.delete(entry.key);
      const controller = new AbortController();
      active = { key: entry.key, controller };
      try {
        await run(entry.value, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) onError(error);
      } finally {
        if (active?.controller === controller) active = null;
        requestDrain();
      }
    });
  }

  function enqueue(key, value, priority = 0) {
    const existing = pending.get(key);
    pending.set(key, {
      key,
      value,
      priority: Math.max(priority, existing?.priority ?? priority),
      order: existing?.order ?? order++
    });
    requestDrain();
  }

  function remove(key) {
    pending.delete(key);
  }

  function cancelActive() {
    active?.controller.abort();
  }

  function clear() {
    pending.clear();
    if (scheduledHandle !== null) {
      cancelScheduled(scheduledHandle);
      scheduledHandle = null;
    }
    cancelActive();
  }

  return { enqueue, remove, cancelActive, clear };
}
