#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expandGovernancePath,
  loadCacheGovernance,
  loadRuntimePaths,
  pathMatchesSimpleGlob,
} from "../lib/runtime-governance.mjs";

const repoRoot = process.cwd();
const config = loadCacheGovernance(repoRoot);
const runtimePaths = loadRuntimePaths(repoRoot);
const runtimePolicy = readFileSync(resolve(repoRoot, "docs/reference/runtime-storage-policy.md"), "utf8");
const loggingPolicy = readFileSync(resolve(repoRoot, "docs/reference/logging-and-cache-policy.md"), "utf8");
const generatedCacheDoc = readFileSync(resolve(repoRoot, "docs/reference/cache-governance.md"), "utf8");
const generatedRuntimePathDoc = readFileSync(resolve(repoRoot, "docs/reference/runtime-paths.md"), "utf8");

function readNodeContractProbe() {
  const raw = execFileSync(
    "bash",
    [
      "-lc",
      'source "$0"; uiq_node_modules_contract_probe "$1"',
      resolve(repoRoot, "scripts/lib/node-toolchain.sh"),
      repoRoot,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return JSON.parse(raw);
}

function normalizePathAlias(pathValue) {
  return String(pathValue).replace(/^\/private\/tmp\//, "/tmp/");
}

const failures = [];
for (const relPath of [
  "scripts/runtime-gc.sh",
  "scripts/cleanup-runtime.sh",
  "scripts/backup-runtime.sh",
  "scripts/rollback-runtime.sh",
]) {
  if (!existsSync(resolve(repoRoot, relPath))) {
    failures.push(`missing runtime contract command: ${relPath}`);
  }
}

if (!runtimePolicy.includes(config.runtime_root)) {
  failures.push(`runtime storage policy must mention runtime root ${config.runtime_root}`);
}
if (!loggingPolicy.includes(config.runtime_root)) {
  failures.push(`logging/cache policy must mention runtime root ${config.runtime_root}`);
}
if (runtimePaths.runtime_root !== config.runtime_root) {
  failures.push(
    `runtime-paths runtime_root must match cache-governance runtime_root (${runtimePaths.runtime_root} != ${config.runtime_root})`,
  );
}
if (!generatedRuntimePathDoc.includes(runtimePaths.runtime_root)) {
  failures.push(`generated runtime paths doc must mention runtime root ${runtimePaths.runtime_root}`);
}

const sharedDependencyContract = runtimePaths.shared_dependency_contract ?? {};
const driftContract = runtimePaths.drift_contract ?? {};
const nodeContractProbe = readNodeContractProbe();
const expectedAuthoritativeRoot = normalizePathAlias(
  resolve(repoRoot, sharedDependencyContract.authoritative_workspace_node_root ?? "node_modules"),
);
const expectedRuntimeBridgeRoot = normalizePathAlias(
  resolve(sharedDependencyContract.runtime_bridge_root ?? "/tmp/uiq-runner/uiq-node-modules"),
);
const expectedFallbackRoot = normalizePathAlias(
  expandGovernancePath(
    sharedDependencyContract.repo_family_node_fallback ?? "${XDG_CACHE_HOME:-$HOME/.cache}/uiq/node-modules",
    repoRoot,
  ),
);

if (normalizePathAlias(nodeContractProbe.authoritativeWorkspaceNodeRoot) !== expectedAuthoritativeRoot) {
  failures.push(
    `node toolchain authoritative workspace root drifted (${nodeContractProbe.authoritativeWorkspaceNodeRoot} != ${expectedAuthoritativeRoot})`,
  );
}
if (normalizePathAlias(nodeContractProbe.runtimeBridgeRoot) !== expectedRuntimeBridgeRoot) {
  failures.push(
    `node toolchain runtime bridge drifted (${nodeContractProbe.runtimeBridgeRoot} != ${expectedRuntimeBridgeRoot})`,
  );
}
if (normalizePathAlias(nodeContractProbe.repoFamilyNodeFallback) !== expectedFallbackRoot) {
  failures.push(
    `node toolchain repo-family fallback drifted (${nodeContractProbe.repoFamilyNodeFallback} != ${expectedFallbackRoot})`,
  );
}
for (const docText of [runtimePolicy, loggingPolicy, generatedRuntimePathDoc]) {
  if (!docText.includes(sharedDependencyContract.authoritative_workspace_node_root ?? "node_modules")) {
    failures.push("runtime policy docs must mention the authoritative workspace node root");
    break;
  }
}
for (const pattern of driftContract.unmanaged_runtime_root_patterns ?? []) {
  if (!generatedRuntimePathDoc.includes(pattern)) {
    failures.push(`generated runtime paths doc must mention unmanaged runtime root pattern: ${pattern}`);
  }
}
for (const name of driftContract.forbidden_workspace_artifact_names ?? []) {
  if (!generatedRuntimePathDoc.includes(name)) {
    failures.push(`generated runtime paths doc must mention forbidden workspace artifact name: ${name}`);
  }
}
for (const docText of [runtimePolicy, loggingPolicy]) {
  if (!docText.includes("pytest-*")) {
    failures.push("runtime cleanup policy docs must mention pytest-* automation leftovers");
    break;
  }
}
if (nodeContractProbe.resolutionMode === "workspace_default") {
  if (normalizePathAlias(nodeContractProbe.resolvedSharedNodeRoot) !== expectedAuthoritativeRoot) {
    failures.push(
      `workspace-default shared node root must resolve to authoritative workspace root (${nodeContractProbe.resolvedSharedNodeRoot} != ${expectedAuthoritativeRoot})`,
    );
  }
  if (
    nodeContractProbe.rootBridge?.present &&
    nodeContractProbe.rootBridge?.kind === "symlink" &&
    !nodeContractProbe.rootBridge?.pointsToAuthoritativeWorkspaceRoot
  ) {
    failures.push("root node_modules bridge must point to authoritative workspace root by default");
  }
  if (nodeContractProbe.rootBridge?.pointsToRepoFamilyFallback) {
    failures.push("root node_modules bridge must not silently point at repo-family fallback");
  }
}
if (nodeContractProbe.rootBridge?.present && nodeContractProbe.rootBridge?.kind === "symlink" && nodeContractProbe.rootBridge?.dangling) {
  failures.push("root node_modules bridge is a dangling symlink");
}
if (
  sharedDependencyContract.runtime_bridge_must_not_dangle === true &&
  nodeContractProbe.runtimeBridge?.present &&
  nodeContractProbe.runtimeBridge?.kind === "symlink" &&
  nodeContractProbe.runtimeBridge?.dangling
) {
  failures.push("runtime bridge root is a dangling symlink");
}

for (const runtimeClass of config.runtime_classes ?? []) {
  if (
    !runtimePolicy.includes(runtimeClass.path) &&
    !loggingPolicy.includes(runtimeClass.path) &&
    !generatedCacheDoc.includes(runtimeClass.path)
  ) {
    failures.push(`runtime class path is undocumented in runtime policy docs: ${runtimeClass.path}`);
  }
}

for (const legacyPath of runtimePaths?.ci_path_contract?.forbidden_legacy_paths ?? []) {
  if (runtimePolicy.includes(legacyPath) || loggingPolicy.includes(legacyPath)) {
    failures.push(`legacy runtime path must not appear in runtime policy docs: ${legacyPath}`);
  }
}

for (const forbiddenPath of runtimePaths?.forbidden_nested_runtime_roots ?? []) {
  if (existsSync(resolve(repoRoot, forbiddenPath))) {
    failures.push(`forbidden nested runtime root present: ${forbiddenPath}`);
  }
  if (loggingPolicy.includes(forbiddenPath) || runtimePolicy.includes(forbiddenPath)) {
    failures.push(`nested runtime root must not appear in policy docs: ${forbiddenPath}`);
  }
}

const runtimeRootPath = resolve(repoRoot, config.runtime_root);
if (existsSync(runtimeRootPath)) {
  const expectedTopLevel = new Set((config.runtime_classes ?? []).map((item) => String(item.path)));
  for (const entry of readdirSync(runtimeRootPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      failures.push(`unexpected file at runtime root: ${config.runtime_root}/${entry.name}`);
      continue;
    }
    if (!expectedTopLevel.has(entry.name)) {
      const relPath = `${config.runtime_root}/${entry.name}`;
      const matchingPattern = (driftContract.unmanaged_runtime_root_patterns ?? []).find((pattern) =>
        pathMatchesSimpleGlob(relPath, pattern),
      );
      if (matchingPattern) {
        failures.push(
          `unmanaged runtime directory present: ${relPath} (matches drift pattern ${matchingPattern})`,
        );
      } else {
        failures.push(`unmanaged runtime directory present: ${relPath}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-runtime-cache-contract] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-runtime-cache-contract] PASS");
