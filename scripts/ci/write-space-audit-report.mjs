#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  expandGovernancePath,
  loadCacheGovernance,
  loadRuntimePaths,
  pathMatchesSimpleGlob,
} from "../lib/runtime-governance.mjs";
import { getExcludedGovernanceSubtrees, getGovernedWorkspaceRoots } from "./workspace-roots.mjs";

const repoRoot = process.cwd();

const cacheConfig = loadCacheGovernance(repoRoot);
const runtimePaths = loadRuntimePaths(repoRoot);

function expandVars(rawPath) {
  return expandGovernancePath(rawPath, repoRoot);
}

function toAbsolute(pathValue) {
  if (isAbsolute(pathValue)) {
    return resolve(pathValue);
  }
  return resolve(repoRoot, pathValue);
}

function pathSizeBytes(absPath) {
  if (!existsSync(absPath)) {
    return 0;
  }
  const stats = lstatSync(absPath);
  if (stats.isSymbolicLink()) {
    return 0;
  }
  if (stats.isFile()) {
    return stats.size;
  }
  if (!stats.isDirectory()) {
    return 0;
  }

  let total = 0;
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    total += pathSizeBytes(join(absPath, entry.name));
  }
  return total;
}

function collectRecursiveDirName(rootRelPath, dirName) {
  const rootAbs = toAbsolute(rootRelPath);
  if (!existsSync(rootAbs)) {
    return [];
  }

  const results = [];
  function walk(absPath) {
    if (!existsSync(absPath)) {
      return;
    }
    const stats = lstatSync(absPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return;
    }
    if (absPath !== rootAbs && absPath.endsWith(`/${dirName}`)) {
      results.push({
        relPath: relative(repoRoot, absPath),
        absPath,
        sizeBytes: pathSizeBytes(absPath),
      });
      return;
    }
    for (const entry of readdirSync(absPath, { withFileTypes: true })) {
      walk(join(absPath, entry.name));
    }
  }

  walk(rootAbs);
  return results;
}

function collectInternalRuleTargets(rule) {
  if (rule.type === "path") {
    const absPath = toAbsolute(rule.path);
    if (!existsSync(absPath)) {
      return [];
    }
    return [{ relPath: rule.path, absPath, sizeBytes: pathSizeBytes(absPath) }];
  }
  if (rule.type === "recursive_dir_name") {
    return collectRecursiveDirName(rule.root, rule.name);
  }
  return [];
}

function dedupeByPath(items) {
  const byPath = new Map();
  for (const item of items) {
    if (!byPath.has(item.relPath)) {
      byPath.set(item.relPath, item);
    }
  }
  return [...byPath.values()];
}

function inspectExternalLayer(layer) {
  const resolvedCandidates = (layer.candidate_paths ?? []).map((candidate) => {
    const absPath = expandVars(candidate);
    const exists = existsSync(absPath);
    return {
      candidate,
      absPath,
      exists,
      sizeBytes: exists ? pathSizeBytes(absPath) : 0,
      mtimeMs: exists ? statSync(absPath).mtimeMs : null,
    };
  });

  const existingPaths = resolvedCandidates
    .filter((item) => item.exists)
    .map((item) => ({
      path: item.absPath,
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs,
    }));

  return {
    id: layer.id,
    ownership: layer.ownership_class,
    bucket: layer.bucket,
    confidence: layer.confidence,
    releasableByCurrentRepo:
      layer.ownership_class === "repo-owned" &&
      layer.bucket === "safe" &&
      layer.attributable_bytes === true,
    attributableBytes: layer.attributable_bytes === true,
    reason: layer.reason,
    paths: existingPaths,
    missingCandidates: resolvedCandidates.filter((item) => !item.exists).map((item) => item.absPath),
    bytes: existingPaths.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

function inspectNodeBridge() {
  const rootNodeModules = resolve(repoRoot, "node_modules");
  if (!existsSync(rootNodeModules)) {
    return {
      path: rootNodeModules,
      present: false,
      kind: "absent",
      target: null,
      targetExists: false,
    };
  }

  const stats = lstatSync(rootNodeModules);
  if (!stats.isSymbolicLink()) {
    return {
      path: rootNodeModules,
      present: true,
      kind: stats.isDirectory() ? "directory" : "file",
      target: rootNodeModules,
      targetExists: true,
    };
  }

  const target = readlinkSync(rootNodeModules);
  const resolvedTarget = toAbsolute(target);
  return {
    path: rootNodeModules,
    present: true,
    kind: "symlink",
    target: resolvedTarget,
    targetExists: existsSync(resolvedTarget),
  };
}

function collectRuntimeRootEntries() {
  const runtimeRootAbs = toAbsolute(cacheConfig.runtime_root);
  if (!existsSync(runtimeRootAbs)) {
    return [];
  }
  const managedNames = new Set((cacheConfig.runtime_classes ?? []).map((item) => String(item.path)));
  return readdirSync(runtimeRootAbs, { withFileTypes: true })
    .map((entry) => {
      const absPath = join(runtimeRootAbs, entry.name);
      return {
        path: `${cacheConfig.runtime_root}/${entry.name}`,
        sizeBytes: pathSizeBytes(absPath),
        managed: managedNames.has(entry.name),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      };
    })
    .sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function collectForbiddenRootOutputs() {
  const blockedPatterns = (cacheConfig.repo_runtime_outputs ?? []).flatMap(
    (item) => item.blocked_root_paths ?? [],
  );
  const results = [];
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    const relPath = entry.name;
    if (!blockedPatterns.some((pattern) => pathMatchesSimpleGlob(relPath, pattern))) {
      continue;
    }
    const absPath = resolve(repoRoot, relPath);
    results.push({
      path: relPath,
      sizeBytes: pathSizeBytes(absPath),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      reason: "forbidden_root_output",
    });
  }
  return results.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function collectForbiddenWorkspaceArtifacts() {
  const governedRoots = getGovernedWorkspaceRoots(repoRoot);
  const excludedRoots = new Set(getExcludedGovernanceSubtrees(repoRoot));
  const forbiddenNames = new Set(runtimePaths?.drift_contract?.forbidden_workspace_artifact_names ?? []);
  const results = [];

  function walk(absPath) {
    if (excludedRoots.has(absPath)) {
      return;
    }
    for (const entry of readdirSync(absPath, { withFileTypes: true })) {
      const nextPath = join(absPath, entry.name);
      if (excludedRoots.has(nextPath) || entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      if (forbiddenNames.has(entry.name)) {
        results.push({
          path: relative(repoRoot, nextPath),
          sizeBytes: pathSizeBytes(nextPath),
          kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          reason: "forbidden_workspace_artifact",
        });
        continue;
      }
      if (entry.isDirectory()) {
        walk(nextPath);
      }
    }
  }

  for (const root of governedRoots) {
    const absRoot = resolve(repoRoot, root);
    if (!existsSync(absRoot)) {
      continue;
    }
    walk(absRoot);
  }

  return results.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function inspectSymlinkHealth() {
  let totalSymlinks = 0;
  let brokenSymlinks = 0;

  function walk(absPath) {
    if (!existsSync(absPath)) {
      return;
    }
    const stats = lstatSync(absPath);
    if (stats.isSymbolicLink()) {
      totalSymlinks += 1;
      if (!existsSync(absPath)) {
        brokenSymlinks += 1;
      }
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(absPath, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      walk(join(absPath, entry.name));
    }
  }

  walk(repoRoot);
  return {
    totalSymlinks,
    brokenSymlinks,
  };
}

const internalBuckets = {};
let repoOwnedImmediatelyReleasableBytes = 0;
for (const [bucketName, rules] of Object.entries(cacheConfig?.space_audit?.internal_bucket_rules ?? {})) {
  const targets = dedupeByPath(
    (rules ?? []).flatMap((rule) =>
      collectInternalRuleTargets(rule).map((item) => ({
        ...item,
        ruleType: rule.type,
        reason: rule.reason,
      })),
    ),
  );
  const bytes = targets.reduce((sum, item) => sum + item.sizeBytes, 0);
  internalBuckets[bucketName] = {
    bytes,
    items: targets.map((item) => ({
      path: item.relPath,
      sizeBytes: item.sizeBytes,
      ruleType: item.ruleType,
      reason: item.reason,
    })),
  };
  if (bucketName === "safe") {
    repoOwnedImmediatelyReleasableBytes = bytes;
  }
}

const externalLayers = (cacheConfig?.space_audit?.external_layers ?? []).map(inspectExternalLayer);

const repoExternalHighConfidenceBytesDeprecated = externalLayers
  .filter((layer) => layer.confidence === "high")
  .reduce((sum, layer) => sum + layer.bytes, 0);

const externalSharedRelatedBytes = externalLayers
  .filter((layer) => layer.ownership === "workspace-shared" || layer.ownership === "machine-shared")
  .reduce((sum, layer) => sum + layer.bytes, 0);

const externalVerifyFirstBytes = externalLayers
  .filter((layer) => layer.bucket === "verify-first")
  .reduce((sum, layer) => sum + layer.bytes, 0);

const externalNonAttributableBytes = externalLayers
  .filter((layer) => !layer.releasableByCurrentRepo)
  .reduce((sum, layer) => sum + layer.bytes, 0);

const runtimeClassSizes = (cacheConfig.runtime_classes ?? [])
  .map((runtimeClass) => {
    const relPath = `${cacheConfig.runtime_root}/${runtimeClass.path}`;
    const absPath = toAbsolute(relPath);
    return {
      id: runtimeClass.id,
      path: relPath,
      retentionTier: runtimeClass.retention_tier,
      sizeBytes: existsSync(absPath) ? pathSizeBytes(absPath) : 0,
      owner: runtimeClass.owner,
    };
  })
  .sort((left, right) => right.sizeBytes - left.sizeBytes);

const runtimeRootEntries = collectRuntimeRootEntries();
const unmanagedRuntimePatterns = runtimePaths?.drift_contract?.unmanaged_runtime_root_patterns ?? [];
const unmanagedRuntimeEntries = runtimeRootEntries
  .filter((entry) => !entry.managed)
  .map((entry) => ({
    ...entry,
    reason: unmanagedRuntimePatterns.some((pattern) => pathMatchesSimpleGlob(entry.path, pattern))
      ? "matches_unmanaged_runtime_root_pattern"
      : "unexpected_runtime_root_entry",
  }));
const forbiddenRootOutputs = collectForbiddenRootOutputs();
const forbiddenWorkspaceArtifacts = collectForbiddenWorkspaceArtifacts();
const symlinkHealth = inspectSymlinkHealth();
const governedRuntimeBytes = runtimeClassSizes.reduce((sum, item) => sum + item.sizeBytes, 0);
const governedRuntimeBytesByTier = Object.fromEntries(
  Object.entries(
    runtimeClassSizes.reduce((acc, item) => {
      acc[item.retentionTier] = (acc[item.retentionTier] ?? 0) + item.sizeBytes;
      return acc;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right)),
);
const unmanagedRuntimeBytes = unmanagedRuntimeEntries.reduce((sum, item) => sum + item.sizeBytes, 0);
const forbiddenRootOutputBytes = forbiddenRootOutputs.reduce((sum, item) => sum + item.sizeBytes, 0);
const forbiddenWorkspaceBytes = forbiddenWorkspaceArtifacts.reduce(
  (sum, item) => sum + item.sizeBytes,
  0,
);
const externalRelatedBytes = externalLayers.reduce((sum, layer) => sum + layer.bytes, 0);

const repoInternalBytes = pathSizeBytes(repoRoot);
const gitMetadataBytes = pathSizeBytes(resolve(repoRoot, ".git"));
const repoOwnedCautiousBytes = internalBuckets.cautious?.bytes ?? 0;

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  repoRoot,
  runtimeRoot: cacheConfig.runtime_root,
  sharedDependencyContract: runtimePaths.shared_dependency_contract ?? {},
  summary: {
    repoInternalBytes,
    repoInternalNonGitBytes: Math.max(0, repoInternalBytes - gitMetadataBytes),
    gitMetadataBytes,
    repoOwnedImmediatelyReleasableBytes,
    repoOwnedCautiousBytes,
    externalSharedRelatedBytes,
    externalVerifyFirstBytes,
    externalNonAttributableBytes,
    rawRepoBytes: repoInternalBytes,
    governedRuntimeBytes,
    governedRuntimeBytesByTier,
    unmanagedRuntimeBytes,
    forbiddenRootOutputBytes,
    forbiddenWorkspaceBytes,
    driftBytes: unmanagedRuntimeBytes + forbiddenRootOutputBytes + forbiddenWorkspaceBytes,
    externalRelatedBytes,
    deprecated: {
      repoExternalHighConfidenceBytes: repoExternalHighConfidenceBytesDeprecated,
      sharedExternalNonAttributableBytes: externalNonAttributableBytes,
    },
  },
  internalBuckets,
  runtimeClasses: runtimeClassSizes,
  runtimeRootEntries,
  drift: {
    unmanagedRuntimeEntries,
    forbiddenRootOutputs,
    forbiddenWorkspaceArtifacts,
  },
  externalLayers,
  nodeBridge: inspectNodeBridge(),
  symlinkHealth,
  warnings: [],
};

if (report.nodeBridge.present && report.nodeBridge.kind === "symlink" && !report.nodeBridge.targetExists) {
  report.warnings.push("root node_modules is a dangling symlink");
}
if (report.drift.unmanagedRuntimeEntries.length > 0) {
  report.warnings.push("runtime root contains unmanaged drift entries");
}
if (report.drift.forbiddenRootOutputs.length > 0) {
  report.warnings.push("forbidden root outputs detected");
}
if (report.drift.forbiddenWorkspaceArtifacts.length > 0) {
  report.warnings.push("forbidden workspace artifact names detected");
}
if (report.symlinkHealth.brokenSymlinks > 0) {
  report.warnings.push("repo contains broken symlinks");
}

const outputFlagIndex = process.argv.indexOf("--output");
const requestedOutputPath =
  outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]
    ? process.argv[outputFlagIndex + 1]
    : process.env.UIQ_SPACE_AUDIT_OUTPUT_PATH ||
      ".runtime-cache/artifacts/ci/space-audit-report.json";
const outputPath = toAbsolute(requestedOutputPath);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`[space-audit-report] wrote ${relative(repoRoot, outputPath)}`);
