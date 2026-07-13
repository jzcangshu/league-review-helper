import assert from "node:assert/strict";
import test from "node:test";

import { createThumbnailRenderQueue } from "../public/thumbnail-render-queue.js";

function controlledScheduler() {
  const callbacks = [];
  return {
    schedule(callback) {
      callbacks.push(callback);
      return callback;
    },
    cancel(callback) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    },
    async runNext() {
      const callback = callbacks.shift();
      if (callback) await callback();
    },
    get size() {
      return callbacks.length;
    }
  };
}

test("thumbnail rendering is serialized and higher-priority visible pages run first", async () => {
  const scheduler = controlledScheduler();
  const started = [];
  const releases = [];
  const queue = createThumbnailRenderQueue({
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancel,
    run: (value) => new Promise((resolve) => {
      started.push(value);
      releases.push(resolve);
    })
  });

  queue.enqueue("page-3", 3, 0);
  queue.enqueue("page-2", 2, 5);
  queue.enqueue("page-1", 1, 10);
  assert.equal(scheduler.size, 1);

  const firstDrain = scheduler.runNext();
  await Promise.resolve();
  assert.deepEqual(started, [1]);
  assert.equal(scheduler.size, 0);

  releases.shift()();
  await firstDrain;
  assert.equal(scheduler.size, 1);
  const secondDrain = scheduler.runNext();
  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  releases.shift()();
  await secondDrain;
});

test("clearing the queue aborts the active thumbnail and discards queued work", async () => {
  const scheduler = controlledScheduler();
  const started = [];
  const queue = createThumbnailRenderQueue({
    schedule: scheduler.schedule,
    cancelScheduled: scheduler.cancel,
    run: (value, signal) => new Promise((resolve) => {
      started.push(value);
      signal.addEventListener("abort", resolve, { once: true });
    })
  });

  queue.enqueue("old-1", "old-1");
  queue.enqueue("old-2", "old-2");
  const drain = scheduler.runNext();
  await Promise.resolve();
  assert.deepEqual(started, ["old-1"]);

  queue.clear();
  await drain;
  assert.equal(scheduler.size, 0);
  assert.deepEqual(started, ["old-1"]);
});
