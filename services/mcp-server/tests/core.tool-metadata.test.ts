// @ts-nocheck
// 
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { startMcpHarnessAdvanced } from "./helpers/mcp-client.js";

function extractRunOverrideKeys(coreSource: string): string[] {
  const block = coreSource.match(/export const runOverrideSchema = \{([\s\S]*?)\} as const;/);
  assert.ok(block, "runOverrideSchema definition must exist");
  return Array.from(
    block[1].matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm),
    (match) => match[1],
  ).sort();
}

test(
  "uiq_run_profile and uiq_run_stream inputSchema stays aligned with runOverrideSchema keys",
  { timeout: 30_000 },
  async () => {
    const typesSource = readFileSync(resolve(".", "services/mcp-server/src/core/types.ts"), "utf8");
    const schemaKeys = extractRunOverrideKeys(typesSource);
    const harness = await startMcpHarnessAdvanced();

    try {
      const listed = await harness.client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      const toolNames = ["uiq_run_profile", "uiq_run_stream", "uiq_run_command"] as const;
      const forbiddenLegacyFields = ["browser", "platform", "device", "headless", "timeout", "env"];

      for (const toolName of toolNames) {
        const tool = byName.get(toolName);
        assert.ok(tool, `missing tool in listTools: ${toolName}`);
        const properties = Object.keys(tool.inputSchema?.properties ?? {}).sort();
        const listedKeys = schemaKeys.filter((key) => properties.includes(key)).sort();
        assert.deepEqual(
          listedKeys,
          schemaKeys,
          `${toolName} inputSchema runOverrideSchema keys drift`,
        );

        for (const legacyField of forbiddenLegacyFields) {
          assert.ok(
            !properties.includes(legacyField),
            `${toolName} inputSchema contains unsupported legacy field: ${legacyField}`,
          );
        }
      }
    } finally {
      await harness.close();
    }
  },
);
