import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildActivateCheck,
  buildDeepInteractionCheck,
  buildInteractionPlan,
  isBusinessInteractionBlocking,
  runDesktopE2E,
} from "./desktop-e2e.js";

test("buildInteractionPlan is deterministic for the same seed", () => {
  const first = buildInteractionPlan(10, 424242);
  const second = buildInteractionPlan(10, 424242);
  assert.deepEqual(second, first);
  assert.ok(new Set(first).size >= 3);
});

test("buildInteractionPlan changes when seed changes", () => {
  const first = buildInteractionPlan(10, 11);
  const second = buildInteractionPlan(10, 12);
  assert.notDeepEqual(second, first);
});

test("business interaction checks are blocking by default", () => {
  assert.equal(isBusinessInteractionBlocking({ targetType: "tauri" }), true);
  assert.equal(
    isBusinessInteractionBlocking({ targetType: "tauri", businessInteractionRequired: true }),
    true,
  );
  assert.equal(
    isBusinessInteractionBlocking({ targetType: "tauri", businessInteractionRequired: false }),
    false,
  );
});

test("runDesktopE2E report includes seed and interaction metadata", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-desktop-e2e-"));
  mkdirSync(join(baseDir, "metrics"), { recursive: true });
  const result = await runDesktopE2E(baseDir, { targetType: "unsupported-target", seed: 777 });
  assert.equal(result.status, "blocked");
  assert.equal(result.interactionMetadata?.seed, 777);
  assert.equal(result.interactionMetadata?.plannerVersion, "seeded-lcg-v1");
  assert.equal(result.interactionMetadata?.roundsPlanned, result.interactionMetadata?.plan.length);

  const stored = JSON.parse(readFileSync(join(baseDir, "metrics/desktop-e2e.json"), "utf8")) as {
    interactionMetadata?: { seed?: number };
  };
  assert.equal(stored.interactionMetadata?.seed, 777);
});

test("buildActivateCheck marks failed activation as blocked", () => {
  const check = buildActivateCheck("tauri", { ok: false, detail: "permission denied" });
  assert.equal(check.id, "desktop.e2e.activate");
  assert.equal(check.status, "blocked");
  assert.equal(check.reasonCode, "desktop.tauri.activate.failed");
});

test("buildDeepInteractionCheck uses successful coverage and exposes reasonCode on failure", () => {
  const blocked = buildDeepInteractionCheck({
    roundsPlanned: 8,
    roundsExecuted: 8,
    passedRounds: 2,
    failedRounds: 6,
    coveredActions: ["click", "tab"],
    coverageRequirementMet: false,
    byAction: {
      click: { attempted: 2, passed: 1, failed: 1 },
      tab: { attempted: 2, passed: 1, failed: 1 },
      scroll: { attempted: 2, passed: 0, failed: 2 },
      input: { attempted: 2, passed: 0, failed: 2 },
    },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reasonCode, "desktop.e2e.deep_interaction.success_coverage_insufficient");
  assert.match(blocked.detail, /success_coverage=click,tab/);
});

test("buildDeepInteractionCheck passes with successful coverage even when some rounds fail", () => {
  const passed = buildDeepInteractionCheck({
    roundsPlanned: 8,
    roundsExecuted: 8,
    passedRounds: 5,
    failedRounds: 3,
    coveredActions: ["click", "tab", "scroll"],
    coverageRequirementMet: true,
    byAction: {
      click: { attempted: 2, passed: 2, failed: 0 },
      tab: { attempted: 2, passed: 1, failed: 1 },
      scroll: { attempted: 2, passed: 1, failed: 1 },
      input: { attempted: 2, passed: 1, failed: 1 },
    },
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.reasonCode, undefined);
});
