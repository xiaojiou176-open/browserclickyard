import assert from "node:assert/strict";
import test from "node:test";
import { buildA11yEngineReadyCheck, buildPerfEngineReadyCheck } from "./run.js";

test("buildPerfEngineReadyCheck returns failed blocker when fallback is used", () => {
  const check = buildPerfEngineReadyCheck({
    fallbackUsed: true,
    metricsCompleteness: "builtin_partial",
    reportPath: "perf/lighthouse.json",
  });

  assert.ok(check);
  assert.equal(check?.id, "perf.engine_ready");
  assert.equal(check?.status, "failed");
  assert.equal(check?.severity, "BLOCKER");
  assert.equal(check?.actual, "builtin_partial");
  assert.equal(check?.evidencePath, "perf/lighthouse.json");
});

test("buildPerfEngineReadyCheck returns undefined when fallback is not used", () => {
  const check = buildPerfEngineReadyCheck({
    fallbackUsed: false,
    metricsCompleteness: "full_lhci",
    reportPath: "perf/lighthouse.json",
  });
  assert.equal(check, undefined);
});

test("buildA11yEngineReadyCheck returns failed blocker when axe fallback is used", () => {
  const check = buildA11yEngineReadyCheck(
    {
      fallbackUsed: true,
      reportPath: "a11y/axe.json",
    },
    "axe",
  );

  assert.ok(check);
  assert.equal(check?.id, "a11y.engine_ready");
  assert.equal(check?.status, "failed");
  assert.equal(check?.severity, "BLOCKER");
  assert.equal(check?.expected, "axe");
  assert.equal(check?.actual, "fallback_used");
  assert.equal(check?.evidencePath, "a11y/axe.json");
});

test("buildA11yEngineReadyCheck returns undefined for builtin engine", () => {
  const check = buildA11yEngineReadyCheck(
    {
      fallbackUsed: true,
      reportPath: "a11y/axe.json",
    },
    "builtin",
  );
  assert.equal(check, undefined);
});
