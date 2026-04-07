// @ts-nocheck
// 
import assert from "node:assert/strict";
import test from "node:test";
import { isAdvancedToolsEnabled } from "../src/core/api-client.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("perfect mode forces advanced tools when not explicitly disabled", () => {
  withEnv(
    {
      UIQ_MCP_PERFECT_MODE: "true",
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: undefined,
    },
    () => {
      assert.equal(isAdvancedToolsEnabled(), true);
    },
  );
});

test("perfect mode defaults to enabled when unset", () => {
  withEnv(
    {
      UIQ_MCP_PERFECT_MODE: undefined,
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: undefined,
    },
    () => {
      assert.equal(isAdvancedToolsEnabled(), true);
    },
  );
});

test("perfect mode fails fast when advanced tools are explicitly disabled", () => {
  withEnv(
    {
      UIQ_MCP_PERFECT_MODE: "true",
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: "false",
    },
    () => {
      assert.throws(
        () => isAdvancedToolsEnabled(),
        /UIQ_MCP_PERFECT_MODE=true requires UIQ_MCP_ENABLE_ADVANCED_TOOLS/,
      );
    },
  );
});

test("non-perfect mode keeps advanced tools opt-in", () => {
  withEnv(
    {
      UIQ_MCP_PERFECT_MODE: "false",
      UIQ_MCP_ENABLE_ADVANCED_TOOLS: "false",
    },
    () => {
      assert.equal(isAdvancedToolsEnabled(), false);
    },
  );
});
