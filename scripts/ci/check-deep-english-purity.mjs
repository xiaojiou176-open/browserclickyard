#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

const TARGET_PATHS = [
  "apps/command-center",
  "tests/frontend-e2e",
  "docs/reference/runtime-paths.md",
  "docs/reference/dependency-governance.md",
  "configs/governance/runtime-paths.yaml",
];

// The command center shell now contains a small set of intentionally bilingual,
// locale-aware operator surfaces. Those files stay allowlisted here so the gate
// can keep protecting every other deep-water app file instead of dropping the
// whole command-center tree from English-purity governance.

const INCLUDED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".yaml", ".yml", ".html"]);
const EXCLUDED_BASENAMES = new Set([".env.example"]);
const EXCLUDED_DIR_BASENAMES = new Set(["node_modules", ".runtime-cache", "tmp", "dist", "build"]);
const ALLOWLISTED_BILINGUAL_PATHS = new Set([
  "apps/command-center/src/App.locale-shell.test.tsx",
  "apps/command-center/src/components/CommandGrid.test.tsx",
  "apps/command-center/src/components/CommandGrid.tsx",
  "apps/command-center/src/components/ConfirmDialog.test.tsx",
  "apps/command-center/src/components/ConfirmDialog.tsx",
  "apps/command-center/src/components/EvidenceScreenshotPair.test.tsx",
  "apps/command-center/src/components/EvidenceScreenshotPair.tsx",
  "apps/command-center/src/components/FlowDraftEditor.test.tsx",
  "apps/command-center/src/components/FlowDraftEditor.tsx",
  "apps/command-center/src/components/HelpPanel.test.tsx",
  "apps/command-center/src/components/HelpPanel.tsx",
  "apps/command-center/src/components/OnboardingTour.test.tsx",
  "apps/command-center/src/components/OnboardingTour.tsx",
  "apps/command-center/src/components/ParamsPanel.contract.test.tsx",
  "apps/command-center/src/components/ParamsPanel.tsx",
  "apps/command-center/src/components/ReconstructionReviewPanel.test.tsx",
  "apps/command-center/src/components/ReconstructionReviewPanel.tsx",
  "apps/command-center/src/components/TaskListPanel.a11y.test.tsx",
  "apps/command-center/src/components/TaskListPanel.tsx",
  "apps/command-center/src/components/TerminalPanel.test.tsx",
  "apps/command-center/src/components/TerminalPanel.tsx",
  "apps/command-center/src/components/ToastStack.test.tsx",
  "apps/command-center/src/components/ToastStack.tsx",
  "apps/command-center/src/features/manual-gates/ManualGateDesk.tsx",
  "apps/command-center/src/shared/reviewInsights.test.ts",
  "apps/command-center/src/shared/reviewInsights.ts",
  "apps/command-center/src/views/FlowWorkshopView.a11y.test.tsx",
  "apps/command-center/src/views/FlowWorkshopView.tsx",
  "apps/command-center/src/views/QuickLaunchView.tsx",
  "apps/command-center/src/views/ReviewBoardView.test.tsx",
  "apps/command-center/src/views/ReviewBoardView.tsx",
  "apps/command-center/src/views/TaskCenterView.tsx",
  "apps/command-center/src/views/TaskCenterView.waiting-state.test.tsx",
]);

const HAN_RE = /[一-龥]/;
const failures = [];

function collectFiles(targetPath) {
  const absPath = resolve(targetPath);
  const stats = statSync(absPath);
  if (stats.isFile()) {
    return [targetPath];
  }

  const files = [];
  const walk = (relDir) => {
    for (const entry of readdirSync(resolve(relDir))) {
      const relPath = join(relDir, entry);
      const normalizedRelPath = relPath.split(sep).join("/");
      if (EXCLUDED_DIR_BASENAMES.has(basename(relPath))) {
        continue;
      }
      const absEntry = resolve(relPath);
      const entryLstat = lstatSync(absEntry);
      if (entryLstat.isSymbolicLink()) {
        continue;
      }
      const entryStats = statSync(absEntry);
      if (entryStats.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!INCLUDED_EXTENSIONS.has(extname(entry))) {
        continue;
      }
      if (EXCLUDED_BASENAMES.has(entry)) {
        continue;
      }
      files.push(normalizedRelPath);
    }
  };

  walk(targetPath);
  return files;
}

for (const targetPath of TARGET_PATHS) {
  for (const relPath of collectFiles(targetPath)) {
    if (ALLOWLISTED_BILINGUAL_PATHS.has(relPath)) {
      continue;
    }
    const absPath = resolve(relPath);
    const content = readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (HAN_RE.test(line)) {
        failures.push(`${relPath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (failures.length > 0) {
  console.error(`[check-deep-english-purity] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-deep-english-purity] PASS");
