// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import { buildVisualBaselineReadyCheck } from "./run.js";

test("buildVisualBaselineReadyCheck fails when diff mode creates baseline", () => {
  const check = buildVisualBaselineReadyCheck(
    {
      mode: "diff",
      baselineCreated: true,
      reportPath: "visual/report.json",
    },
    "diff",
  );

  assert.ok(check);
  assert.equal(check?.id, "visual.baseline_ready");
  assert.equal(check?.status, "failed");
  assert.equal(check?.severity, "BLOCKER");
  assert.equal(check?.reasonCode, "gate.visual_baseline_ready.failed.baseline_created");
});

test("buildVisualBaselineReadyCheck passes through when baseline already exists", () => {
  const check = buildVisualBaselineReadyCheck(
    {
      mode: "diff",
      baselineCreated: false,
      reportPath: "visual/report.json",
    },
    "diff",
  );
  assert.equal(check, undefined);
});
