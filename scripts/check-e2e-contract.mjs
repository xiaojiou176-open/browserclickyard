import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const requiredContracts = [
  {
    type: "literal",
    file: "apps/command-center/src/constants/testIds.ts",
    reason: "missing testid literal",
    entries: [
      "console-tab-quick-launch",
      "console-tab-task-center",
      "console-tab-flow-draft",
      "task-center-tab-command-runs",
      "task-center-tab-template-runs",
      "task-center-panel-command-runs",
      "task-center-panel-template-runs",
    ],
  },
  {
    type: "symbol",
    file: "apps/command-center/src/components/ConsoleHeader.tsx",
    reason: "missing testid constant reference",
    entries: [
      "CONSOLE_TAB_QUICK_LAUNCH_TEST_ID",
      "CONSOLE_TAB_TASK_CENTER_TEST_ID",
      "CONSOLE_TAB_FLOW_DRAFT_TEST_ID",
    ],
  },
  {
    type: "symbol",
    file: "apps/command-center/src/views/TaskCenterView.tsx",
    reason: "missing testid constant reference",
    entries: [
      "TASK_CENTER_TAB_COMMAND_RUNS_TEST_ID",
      "TASK_CENTER_TAB_TEMPLATE_RUNS_TEST_ID",
      "TASK_CENTER_PANEL_COMMAND_RUNS_TEST_ID",
      "TASK_CENTER_PANEL_TEMPLATE_RUNS_TEST_ID",
    ],
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStringLiteral(content, value) {
  const pattern = new RegExp(`['"]${escapeRegExp(value)}['"]`);
  return pattern.test(content);
}

function hasSymbolReference(content, symbol) {
  return content.includes(symbol);
}

const missingContracts = [];

for (const contract of requiredContracts) {
  const absolutePath = path.join(repoRoot, contract.file);
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of contract.entries) {
      missingContracts.push({
        entry,
        file: contract.file,
        reason: `unable to read file (${message})`,
      });
    }
    continue;
  }

  for (const entry of contract.entries) {
    const exists =
      contract.type === "literal"
        ? hasStringLiteral(content, entry)
        : hasSymbolReference(content, entry);

    if (!exists) {
      missingContracts.push({
        entry,
        file: contract.file,
        reason: contract.reason,
      });
    }
  }
}

if (missingContracts.length > 0) {
  for (const _item of missingContracts) {
  }
  process.exit(1);
}
