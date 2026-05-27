import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, validateRunOverrides } from "./cli.js";
import { listCatalogCommands } from "./commands/catalog.js";

test("parseArgs keeps raw invalid enum values for validate stage", () => {
  const args = parseArgs(["run", "--load-engine", "invalid-engine", "--perf-preset", "tablet"]);
  assert.equal(args.loadEngine, "invalid-engine");
  assert.equal(args.perfPreset, "tablet");
});

test("validateRunOverrides rejects invalid load-engine", () => {
  const args = parseArgs(["run", "--load-engine", "invalid-engine"]);
  assert.throws(() => validateRunOverrides(args), /Invalid --load-engine/);
});

test("validateRunOverrides rejects invalid a11y/perf/visual enums", () => {
  const args = parseArgs([
    "run",
    "--a11y-engine",
    "other",
    "--perf-engine",
    "other",
    "--visual-mode",
    "other",
  ]);
  assert.throws(
    () => validateRunOverrides(args),
    /Invalid --a11y-engine|Invalid --perf-engine|Invalid --visual-mode/,
  );
});

test("parseArgs and validateRunOverrides accept gemini strategy overrides", () => {
  const args = parseArgs([
    "run",
    "--gemini-model",
    "gemini-3.1-pro-preview",
    "--gemini-thinking-level",
    "high",
    "--gemini-tool-mode",
    "validated",
    "--gemini-context-cache-mode",
    "api",
    "--gemini-media-resolution",
    "high",
  ]);
  assert.equal(args.geminiModel, "gemini-3.1-pro-preview");
  assert.equal(args.geminiThinkingLevel, "high");
  assert.equal(args.geminiToolMode, "validated");
  assert.equal(args.geminiContextCacheMode, "api");
  assert.equal(args.geminiMediaResolution, "high");
  assert.doesNotThrow(() => validateRunOverrides(args));
});

test("catalog commands include desktop-smoke and web command set", () => {
  const commands = listCatalogCommands();
  assert.ok(commands.includes("desktop-smoke"));
  assert.ok(commands.includes("run"));
  assert.ok(commands.includes("capture"));
  assert.ok(commands.includes("report"));
});
