#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_WORKSPACE_ROOTS = ["apps", "services", "tooling", "packages", "scripts", "tests"];
const DEFAULT_EXCLUDED_SUBTREES = ["services/mcp-server/tests/fixtures/workspace"];

export function getGovernedWorkspaceRoots(repoRoot = process.cwd()) {
  return DEFAULT_WORKSPACE_ROOTS.filter((root) => existsSync(resolve(repoRoot, root)));
}

export function getExcludedGovernanceSubtrees(repoRoot = process.cwd()) {
  return DEFAULT_EXCLUDED_SUBTREES.map((subtree) => resolve(repoRoot, subtree)).filter((absPath) =>
    existsSync(absPath),
  );
}
