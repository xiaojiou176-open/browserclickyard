import assert from "node:assert/strict";
import test from "node:test";
import { waitForPageSettled } from "./page-stability.js";

test("waitForPageSettled waits for load before settling frames", async () => {
  const calls: string[] = [];
  const page = {
    waitForLoadState: async (state: string, options: { timeout: number }) => {
      calls.push(`wait:${state}:${options.timeout}`);
    },
    evaluate: async () => {
      calls.push("evaluate");
    },
  };

  await waitForPageSettled(page as never, 1234);

  assert.deepEqual(calls, ["wait:load:1234", "evaluate"]);
});

test("waitForPageSettled still settles frames when load wait times out", async () => {
  const calls: string[] = [];
  const page = {
    waitForLoadState: async () => {
      calls.push("wait");
      throw new Error("timed out");
    },
    evaluate: async () => {
      calls.push("evaluate");
    },
  };

  await waitForPageSettled(page as never, 10);

  assert.deepEqual(calls, ["wait", "evaluate"]);
});

test("waitForPageSettled rethrows non-timeout load failures", async () => {
  const page = {
    waitForLoadState: async () => {
      throw new Error("page closed");
    },
    evaluate: async () => undefined,
  };

  await assert.rejects(waitForPageSettled(page as never, 10), /page closed/);
});

test("waitForPageSettled times out when frame settling hangs", async () => {
  const page = {
    waitForLoadState: async () => undefined,
    evaluate: async () => new Promise<void>(() => undefined),
  };

  await assert.rejects(waitForPageSettled(page as never, 5), /page settle timed out/i);
});
