#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const repoRoot = process.cwd();
const config = YAML.parse(
  readFileSync(resolve(repoRoot, "configs/governance/cache-governance.yaml"), "utf8"),
);
const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");

const failures = [];
const runtimeClassIds = new Set();
const runtimeClassPaths = new Set();
const retentionTierIds = new Set(Object.keys(config.retention_tiers ?? {}));
const allowedBuckets = new Set(config?.space_audit?.buckets ?? []);
const allowedOwnershipClasses = new Set(config?.space_audit?.ownership_classes ?? []);

if (!config.retention_tiers || retentionTierIds.size === 0) {
  failures.push("retention_tiers must not be empty");
}

if (config.runtime_root !== ".runtime-cache") {
  failures.push(`runtime_root must be '.runtime-cache', got ${config.runtime_root}`);
}

if (!Array.isArray(config.runtime_classes) || config.runtime_classes.length === 0) {
  failures.push("runtime_classes must not be empty");
}

for (const runtimeClass of config.runtime_classes ?? []) {
  if (!runtimeClass.id || !runtimeClass.path || !runtimeClass.owner) {
    failures.push(`runtime class missing id/path/owner: ${JSON.stringify(runtimeClass)}`);
  }
  if (!Number.isInteger(runtimeClass.retention_days) || runtimeClass.retention_days < 0) {
    failures.push(`runtime class retention_days must be non-negative integer: ${runtimeClass.id}`);
  }
  if (typeof runtimeClass.cleanup_scope !== "string" || !runtimeClass.cleanup_scope.trim()) {
    failures.push(`runtime class cleanup_scope must be set: ${runtimeClass.id}`);
  }
  if (!runtimeClass.retention_tier || !retentionTierIds.has(runtimeClass.retention_tier)) {
    failures.push(`runtime class retention_tier must reference a declared retention tier: ${runtimeClass.id}`);
  }
  if (runtimeClassIds.has(runtimeClass.id)) {
    failures.push(`duplicate runtime class id: ${runtimeClass.id}`);
  }
  if (runtimeClassPaths.has(runtimeClass.path)) {
    failures.push(`duplicate runtime class path: ${runtimeClass.path}`);
  }
  runtimeClassIds.add(runtimeClass.id);
  runtimeClassPaths.add(runtimeClass.path);
}

if (!config.space_audit) {
  failures.push("space_audit section must be configured");
}

for (const bucketName of ["safe", "cautious", "verify-first", "do-not-touch"]) {
  if (!allowedBuckets.has(bucketName)) {
    failures.push(`space_audit bucket missing: ${bucketName}`);
  }
}

for (const ownership of ["repo-owned", "workspace-shared", "machine-shared", "unknown"]) {
  if (!allowedOwnershipClasses.has(ownership)) {
    failures.push(`space_audit ownership class missing: ${ownership}`);
  }
}

for (const [bucketName, rules] of Object.entries(config?.space_audit?.internal_bucket_rules ?? {})) {
  if (!allowedBuckets.has(bucketName)) {
    failures.push(`internal bucket rule references unknown bucket: ${bucketName}`);
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    failures.push(`internal bucket rule must contain at least one rule: ${bucketName}`);
    continue;
  }
  for (const rule of rules) {
    if (!rule?.type || !rule?.reason) {
      failures.push(`internal bucket rule missing type/reason: ${bucketName}`);
      continue;
    }
    if (rule.type === "path" && !rule.path) {
      failures.push(`path-based internal bucket rule missing path: ${bucketName}`);
    }
    if (rule.type === "recursive_dir_name" && (!rule.root || !rule.name)) {
      failures.push(`recursive_dir_name rule missing root/name: ${bucketName}`);
    }
  }
}

for (const layer of config?.space_audit?.external_layers ?? []) {
  if (!layer?.id) {
    failures.push(`external layer missing id: ${JSON.stringify(layer)}`);
    continue;
  }
  if (!allowedOwnershipClasses.has(layer.ownership_class)) {
    failures.push(`external layer references unknown ownership_class: ${layer.id}`);
  }
  if (!allowedBuckets.has(layer.bucket)) {
    failures.push(`external layer references unknown bucket: ${layer.id}`);
  }
  if (!Array.isArray(layer.candidate_paths) || layer.candidate_paths.length === 0) {
    failures.push(`external layer must define candidate_paths: ${layer.id}`);
  }
  if (typeof layer.reason !== "string" || !layer.reason.trim()) {
    failures.push(`external layer reason must be set: ${layer.id}`);
  }
  if (
    (layer.ownership_class === "workspace-shared" || layer.ownership_class === "machine-shared") &&
    layer.attributable_bytes === true
  ) {
    failures.push(`shared external layer must not claim repo-owned releasable bytes: ${layer.id}`);
  }
}

for (const item of config.repo_runtime_outputs ?? []) {
  for (const blocked of item.blocked_root_paths ?? []) {
    const basename = String(blocked).replace(/\/$/, "");
    const wildcard = basename.includes("*");
    const expectedEntries = [
      `/${basename}`,
      `${basename}/`,
      `${basename}`,
      `**/${basename}/**`,
      `**/${basename}`,
      `*.${basename.split(".").pop()}`,
    ];
    if (!wildcard && !expectedEntries.some((entry) => gitignore.includes(entry))) {
      failures.push(`blocked root path not represented in .gitignore: ${blocked}`);
    }
  }
}

if (!Array.isArray(config.cleanup_commands) || config.cleanup_commands.length === 0) {
  failures.push("cleanup_commands must list at least one command");
}

if (typeof config.repro_without_cache_command !== "string" || !config.repro_without_cache_command) {
  failures.push("repro_without_cache_command must be set");
}

if (failures.length > 0) {
  console.error(`[check-cache-governance] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-cache-governance] PASS");
