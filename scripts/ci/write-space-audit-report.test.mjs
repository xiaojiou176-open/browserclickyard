import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

test("space audit report separates repo-owned bytes from shared external layers", () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), "uiq-space-audit-"));
  const reportPath = resolve(tempDir, "space-audit-report.json");

  try {
    execFileSync(
      "bash",
      [
        "scripts/lib/node-governance-entry.sh",
        "scripts/ci/write-space-audit-report.mjs",
        "--output",
        reportPath,
      ],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );

    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    assert.equal(typeof report.summary.repoInternalBytes, "number");
    assert.equal(typeof report.summary.repoInternalNonGitBytes, "number");
    assert.equal(typeof report.summary.gitMetadataBytes, "number");
    assert.equal(typeof report.summary.repoOwnedImmediatelyReleasableBytes, "number");
    assert.equal(typeof report.summary.repoOwnedCautiousBytes, "number");
    assert.equal(typeof report.summary.externalSharedRelatedBytes, "number");
    assert.equal(typeof report.summary.externalVerifyFirstBytes, "number");
    assert.equal(typeof report.summary.externalNonAttributableBytes, "number");
    assert.equal(typeof report.summary.rawRepoBytes, "number");
    assert.equal(typeof report.summary.governedRuntimeBytes, "number");
    assert.equal(typeof report.summary.unmanagedRuntimeBytes, "number");
    assert.equal(typeof report.summary.forbiddenRootOutputBytes, "number");
    assert.equal(typeof report.summary.forbiddenWorkspaceBytes, "number");
    assert.equal(typeof report.summary.driftBytes, "number");
    assert.ok(report.summary.repoInternalBytes >= report.summary.repoInternalNonGitBytes);
    assert.equal(
      report.summary.repoInternalBytes,
      report.summary.repoInternalNonGitBytes + report.summary.gitMetadataBytes,
    );
    assert.ok(Array.isArray(report.runtimeRootEntries));
    assert.ok(Array.isArray(report.drift.unmanagedRuntimeEntries));
    assert.ok(Array.isArray(report.drift.forbiddenRootOutputs));
    assert.ok(Array.isArray(report.drift.forbiddenWorkspaceArtifacts));
    assert.equal(typeof report.symlinkHealth.totalSymlinks, "number");
    assert.equal(typeof report.symlinkHealth.brokenSymlinks, "number");

    for (const layer of report.externalLayers) {
      if (layer.ownership === "workspace-shared" || layer.ownership === "machine-shared") {
        assert.equal(layer.releasableByCurrentRepo, false);
      }
    }

    const runtimeBridgeLayer = report.externalLayers.find(
      (layer) => layer.id === "runtime_bridge_node_root",
    );
    assert.ok(runtimeBridgeLayer, "runtime bridge external layer should be present");
    assert.equal(runtimeBridgeLayer.ownership, "workspace-shared");
    assert.equal(runtimeBridgeLayer.bucket, "verify-first");
    assert.ok(
      runtimeBridgeLayer.missingCandidates.includes("/tmp/uiq-runner/uiq-node-modules") ||
        runtimeBridgeLayer.paths.some((item) => item.path === "/tmp/uiq-runner/uiq-node-modules"),
      "runtime bridge layer should track the contract runtime bridge root",
    );
    assert.ok(
      report.runtimeRootEntries.every((entry) => entry.path.startsWith(".runtime-cache/")),
      "runtime root entries should be reported relative to .runtime-cache",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
