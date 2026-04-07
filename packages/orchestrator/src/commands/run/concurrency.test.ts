import assert from "node:assert/strict";
import test from "node:test";
import { type ConcurrentTask, runWithConcurrencyLimit, throwIfAborted } from "./concurrency.js";

test("runWithConcurrencyLimit aborts in-flight cooperative task and skips queued task", async () => {
  let releaseFailingTask: () => void = () => undefined;
  const failingGate = new Promise<void>((resolvePromise) => {
    releaseFailingTask = resolvePromise;
  });
  let cooperativeSideEffect = 0;
  let queuedTaskStarted = false;

  const tasks: ConcurrentTask[] = [
    async () => {
      await failingGate;
      throw new Error("first failure");
    },
    async (signal) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      throwIfAborted(signal);
      cooperativeSideEffect += 1;
    },
    async () => {
      queuedTaskStarted = true;
    },
  ];

  const running = runWithConcurrencyLimit(tasks, 2);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  releaseFailingTask();

  await assert.rejects(running, /first failure/u);
  assert.equal(cooperativeSideEffect, 0);
  assert.equal(queuedTaskStarted, false);
});

test("runWithConcurrencyLimit stops remaining serial tasks after first error", async () => {
  const executed: number[] = [];
  await assert.rejects(
    runWithConcurrencyLimit(
      [
        async () => {
          executed.push(1);
          throw new Error("serial failed");
        },
        async () => {
          executed.push(2);
        },
      ],
      1,
    ),
    /serial failed/u,
  );
  assert.deepEqual(executed, [1]);
});
