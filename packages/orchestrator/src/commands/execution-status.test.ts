import assert from "node:assert/strict";
import test from "node:test";
import { deriveExploreExecutionStatus } from "./explore.js";
import { deriveVisualExecutionStatus } from "./visual.js";

test("deriveExploreExecutionStatus blocks when no states are discovered", () => {
  const result = deriveExploreExecutionStatus({ discoveredStates: 0 });
  assert.equal(result.executionStatus, "blocked");
  assert.equal(result.blockedReasonCode, "gate.explore_engine.blocked.no_states_discovered");
});

test("deriveExploreExecutionStatus keeps ok when at least one state is discovered", () => {
  const result = deriveExploreExecutionStatus({ discoveredStates: 1 });
  assert.equal(result.executionStatus, "ok");
  assert.equal(result.blockedReasonCode, undefined);
});

test("deriveVisualExecutionStatus blocks when diff pixels exceed configured max", () => {
  const result = deriveVisualExecutionStatus({ diffPixels: 11, maxDiffPixels: 10 });
  assert.equal(result.executionStatus, "blocked");
  assert.equal(result.blockedReasonCode, "gate.visual_engine.blocked.diff_pixels_exceeded");
});

test("deriveVisualExecutionStatus keeps ok when maxDiffPixels is not configured", () => {
  const result = deriveVisualExecutionStatus({ diffPixels: 999 });
  assert.equal(result.executionStatus, "ok");
  assert.equal(result.blockedReasonCode, undefined);
});
