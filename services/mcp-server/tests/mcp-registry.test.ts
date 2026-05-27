// @ts-nocheck
// 
import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCED_TOOL_NAMES,
  ALL_REGISTERED_TOOL_NAMES,
  ANALYSIS_TOOL_NAMES,
  CORE_12_TOOL_NAMES,
  isToolEnabled,
  PROOF_TOOL_NAMES,
  REGISTER_TOOL_NAMES,
  resolveEnabledToolGroups,
} from "../src/core/registry.js";

test("registry defaults to core tools only", () => {
  const groups = resolveEnabledToolGroups({});
  assert.deepEqual(Array.from(groups).sort(), ["core"]);

  assert.equal(isToolEnabled(CORE_12_TOOL_NAMES[0], groups), true);
  assert.equal(isToolEnabled("uiq_api_automation_commands", groups), false);
  assert.equal(isToolEnabled("uiq_register_orchestrate", groups), false);
});

test("registry parses explicit groups and ignores unknown values", () => {
  const groups = resolveEnabledToolGroups({
    UIQ_MCP_TOOL_GROUPS: " advanced, REGISTER,proof,unknown ,  ",
  });
  assert.deepEqual(Array.from(groups).sort(), ["advanced", "core", "proof", "register"]);

  assert.equal(isToolEnabled("uiq_api_automation_commands", groups), true);
  assert.equal(isToolEnabled("uiq_register_orchestrate", groups), true);
  assert.equal(isToolEnabled("uiq_a11y_top", groups), false);
});

test("registry supports all keyword and legacy flags", () => {
  const allGroups = resolveEnabledToolGroups({ UIQ_MCP_TOOL_GROUPS: "all" });
  assert.deepEqual(Array.from(allGroups).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);
  assert.equal(isToolEnabled("uiq_a11y_top", allGroups), true);
  assert.equal(isToolEnabled("uiq_run_proof_campaign", allGroups), true);

  const allGroupsUpper = resolveEnabledToolGroups({ UIQ_MCP_TOOL_GROUPS: "ALL" });
  assert.deepEqual(Array.from(allGroupsUpper).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const byLegacyExpose = resolveEnabledToolGroups({ UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "yes" });
  assert.deepEqual(Array.from(byLegacyExpose).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const byLegacyEnable = resolveEnabledToolGroups({ UIQ_MCP_ENABLE_ADVANCED_TOOLS: "true" });
  assert.deepEqual(Array.from(byLegacyEnable).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const byLegacyOn = resolveEnabledToolGroups({ UIQ_MCP_EXPOSE_ADVANCED: "on" });
  assert.deepEqual(Array.from(byLegacyOn).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const byLegacyNumeric = resolveEnabledToolGroups({ UIQ_MCP_ENABLE_ADVANCED_TOOLS: "1" });
  assert.deepEqual(Array.from(byLegacyNumeric).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const byLegacyNegative = resolveEnabledToolGroups({
    UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "off",
    UIQ_MCP_ENABLE_ADVANCED_TOOLS: "0",
  });
  assert.deepEqual(Array.from(byLegacyNegative).sort(), ["core"]);
});

test("registry accepts only strict legacy boolean tokens", () => {
  const truthyTokens = ["1", "true", "yes", "on", " TRUE ", " Yes "];
  for (const token of truthyTokens) {
    const groups = resolveEnabledToolGroups({ UIQ_MCP_EXPOSE_ADVANCED_TOOLS: token });
    assert.deepEqual(Array.from(groups).sort(), [
      "advanced",
      "analysis",
      "core",
      "proof",
      "register",
    ]);
  }

  const falsyOrInvalidTokens = ["", "0", "false", "off", "enabled", "y", "2", " no "];
  for (const token of falsyOrInvalidTokens) {
    const groups = resolveEnabledToolGroups({ UIQ_MCP_EXPOSE_ADVANCED_TOOLS: token });
    assert.deepEqual(Array.from(groups).sort(), ["core"]);
  }
});

test("registry parsing keeps deterministic unique explicit groups", () => {
  const groups = resolveEnabledToolGroups({
    UIQ_MCP_TOOL_GROUPS: " advanced,analysis,advanced,proof,unknown, ,analysis ",
  });
  assert.deepEqual(Array.from(groups).sort(), ["advanced", "analysis", "core", "proof"]);
});

test("registry legacy expose/enable flags behave as logical OR", () => {
  const exposeOnly = resolveEnabledToolGroups({
    UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "true",
    UIQ_MCP_ENABLE_ADVANCED_TOOLS: "false",
  });
  assert.deepEqual(Array.from(exposeOnly).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const enableOnly = resolveEnabledToolGroups({
    UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false",
    UIQ_MCP_ENABLE_ADVANCED_TOOLS: "true",
  });
  assert.deepEqual(Array.from(enableOnly).sort(), [
    "advanced",
    "analysis",
    "core",
    "proof",
    "register",
  ]);

  const neither = resolveEnabledToolGroups({
    UIQ_MCP_EXPOSE_ADVANCED_TOOLS: "false",
    UIQ_MCP_ENABLE_ADVANCED_TOOLS: "false",
  });
  assert.deepEqual(Array.from(neither).sort(), ["core"]);
});

test("registry exposes deterministic unique tool names", () => {
  assert.equal(ALL_REGISTERED_TOOL_NAMES.length > 0, true);
  assert.deepEqual([...ALL_REGISTERED_TOOL_NAMES], [...ALL_REGISTERED_TOOL_NAMES].sort());
  assert.equal(new Set(ALL_REGISTERED_TOOL_NAMES).size, ALL_REGISTERED_TOOL_NAMES.length);

  const expectedAllNames = Array.from(
    new Set([
      ...CORE_12_TOOL_NAMES,
      ...ADVANCED_TOOL_NAMES,
      ...REGISTER_TOOL_NAMES,
      ...PROOF_TOOL_NAMES,
      ...ANALYSIS_TOOL_NAMES,
    ]),
  ).sort();
  assert.deepEqual(ALL_REGISTERED_TOOL_NAMES, expectedAllNames);
  assert.equal(ALL_REGISTERED_TOOL_NAMES.includes("uiq_backend_runtime"), true);
  assert.equal(ALL_REGISTERED_TOOL_NAMES.includes("uiq_a11y_top"), true);
  assert.equal(ALL_REGISTERED_TOOL_NAMES.includes("uiq_register_state"), true);
});

test("registry enforces tool enabled lookup by explicit group membership", () => {
  const advancedOnly = resolveEnabledToolGroups({ UIQ_MCP_TOOL_GROUPS: "advanced" });
  for (const toolName of ADVANCED_TOOL_NAMES) {
    assert.equal(isToolEnabled(toolName, advancedOnly), true);
  }
  for (const toolName of REGISTER_TOOL_NAMES) {
    assert.equal(isToolEnabled(toolName, advancedOnly), false);
  }
  for (const toolName of PROOF_TOOL_NAMES) {
    assert.equal(isToolEnabled(toolName, advancedOnly), false);
  }
  for (const toolName of ANALYSIS_TOOL_NAMES) {
    assert.equal(isToolEnabled(toolName, advancedOnly), false);
  }
  assert.equal(isToolEnabled("uiq_non_existing_tool", advancedOnly), false);
});
