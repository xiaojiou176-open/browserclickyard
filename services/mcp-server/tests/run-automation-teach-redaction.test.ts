// @ts-nocheck
// 
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runAutomationTeach } from "../src/tools/register-tools/shared.js";

test("runAutomationTeach redacts sensitive stdout/stderr content", () => {
  const fakeBin = resolve(import.meta.dirname, "fixtures/bin/fake-automation-teach.sh");
  const prevFakeBin = process.env.UIQ_MCP_FAKE_AUTOMATION_TEACH_BIN;
  try {
    process.env.UIQ_MCP_FAKE_AUTOMATION_TEACH_BIN = fakeBin;
    const result = runAutomationTeach({
      mode: "manual",
      startUrl: "http://127.0.0.1:17381",
    });
    assert.equal(result.ok, true);
    assert.equal(result.runId, "run-teach");
    assert.match(result.stdout, /token=\[REDACTED\]/i);
    assert.doesNotMatch(result.stdout, /plain-secret-token/);
    assert.match(result.stderr, /PASSWORD=\[REDACTED\]/);
    assert.doesNotMatch(result.stderr, /super-secret-password/);
  } finally {
    if (prevFakeBin === undefined) {
      delete process.env.UIQ_MCP_FAKE_AUTOMATION_TEACH_BIN;
    } else {
      process.env.UIQ_MCP_FAKE_AUTOMATION_TEACH_BIN = prevFakeBin;
    }
  }
});
