// @ts-nocheck
// 
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function extractQuotedItems(section: string): string[] {
  return Array.from(section.matchAll(/"([^"]+)"/g), (match) => match[1]);
}

function extractCliCommands(fileText: string): string[] {
  const match = fileText.match(/const SUPPORTED_COMMANDS = \[([\s\S]*?)\] as const/);
  if (!match) {
    throw new Error("SUPPORTED_COMMANDS not found in CLI source");
  }
  return extractQuotedItems(match[1]);
}

function extractCatalogCommands(fileText: string): string[] {
  const match = fileText.match(/const commands = \[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("commands array not found in MCP catalog source");
  }
  return extractQuotedItems(match[1]);
}

function extractCatalogCommandDescriptionKeys(fileText: string): string[] {
  const match = fileText.match(/const commandDescriptions = \{([\s\S]*?)\};/);
  if (!match) {
    throw new Error("commandDescriptions object not found in MCP catalog source");
  }
  return Array.from(match[1].matchAll(/"([^"]+)"\s*:/g), (token) => token[1]);
}

function extractRegisteredToolNames(fileText: string): string[] {
  return Array.from(fileText.matchAll(/registerTool\(\s*"([^"]+)"/g), (match) => match[1]);
}

test("uiq_catalog command list stays in sync with orchestrator CLI", () => {
  const repoRoot = resolve(import.meta.dirname, "../../../");
  const cliSource = readFileSync(resolve(repoRoot, "packages/orchestrator/src/cli.ts"), "utf8");
  const catalogSource = readFileSync(
    resolve(repoRoot, "services/mcp-server/src/tools/register-tools/register-run-tools.ts"),
    "utf8",
  );

  const cliCommands = extractCliCommands(cliSource);
  const catalogCommands = extractCatalogCommands(catalogSource);
  const descriptionKeys = extractCatalogCommandDescriptionKeys(catalogSource);
  const registeredTools = extractRegisteredToolNames(catalogSource);

  assert.deepEqual(catalogCommands, cliCommands);
  assert.ok(catalogCommands.includes("computer-use"));
  assert.ok(descriptionKeys.includes("computer-use"));
  assert.ok(registeredTools.includes("uiq_computer_use_run"));
});
