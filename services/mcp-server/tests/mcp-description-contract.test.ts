// @ts-nocheck
// 
//

import assert from "node:assert/strict";
import test from "node:test";
import { startMcpHarnessAdvanced } from "./helpers/mcp-client.js";

const CORE_DESCRIPTION_TOOLS = [
  "uiq_backend_runtime",
  "uiq_api_sessions",
  "uiq_register_orchestrate",
  "uiq_register_state",
  "uiq_api_flows",
  "uiq_api_templates",
  "uiq_api_runs",
] as const;

const NAVIGATION_FIELDS = [
  "Goal:",
  "Use When:",
  "Required Inputs:",
  "Call Order:",
  "Success Output:",
  "If Failed:",
  "Do Not:",
] as const;

const LEGACY_BILINGUAL_FIELDS = [
  "Goal / 目标:",
  "Use When / 何时使用:",
  "Required Inputs / 必填输入:",
  "Call Order / 调用顺序:",
  "Success Output / 成功输出:",
  "If Failed / 失败处理:",
  "Do Not / 禁止事项:",
] as const;

const CJK_PATTERN = /[\u3400-\u9fff]/u;

test(
  "mcp core description contract: English canonical navigation fields are present",
  { timeout: 30_000 },
  async () => {
    const harness = await startMcpHarnessAdvanced();

    try {
      const listed = await harness.client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

      for (const toolName of CORE_DESCRIPTION_TOOLS) {
        const tool = byName.get(toolName);
        assert.ok(tool, `missing tool in listTools: ${toolName}`);
        assert.equal(typeof tool.description, "string", `description must be string: ${toolName}`);

        const description = tool.description ?? "";
        for (const field of NAVIGATION_FIELDS) {
          assert.ok(description.includes(field), `${toolName} description missing field: ${field}`);
        }
        for (const legacyField of LEGACY_BILINGUAL_FIELDS) {
          assert.ok(
            !description.includes(legacyField),
            `${toolName} description still contains legacy bilingual field: ${legacyField}`,
          );
        }
        assert.ok(
          !CJK_PATTERN.test(description),
          `${toolName} description must stay English canonical without CJK characters`,
        );
      }
    } finally {
      await harness.close();
    }
  },
);
