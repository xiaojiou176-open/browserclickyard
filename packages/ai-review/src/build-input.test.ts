import assert from "node:assert/strict";
import test from "node:test";
import type { Manifest } from "../../core/src/manifest/types.js";
import { buildAiReviewInput } from "./build-input.js";

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: "1.1",
    runId: "run-build-input",
    target: { type: "web", name: "web.local" },
    profile: "pr",
    git: { branch: "main", commit: "abc123", dirty: false },
    timing: {
      startedAt: "2026-02-21T00:00:00.000Z",
      finishedAt: "2026-02-21T00:00:05.000Z",
      durationMs: 5000,
    },
    execution: { maxParallelTasks: 1, stagesMs: {}, criticalPath: [] },
    states: [],
    evidenceIndex: [],
    reports: {},
    summary: { consoleError: 0, pageError: 0, http5xx: 0 },
    gateResults: { status: "passed", checks: [] },
    toolchain: { node: process.version },
    ...overrides,
  };
}

test("buildAiReviewInput includes video candidates and prioritizes key video paths", () => {
  const manifest = baseManifest({
    reports: { report: "reports/summary.json" },
    evidenceIndex: [
      { id: "state.home.dom", source: "state", kind: "dom", path: "dom/home.html" },
      {
        id: "state.home.screenshot",
        source: "state",
        kind: "screenshot",
        path: "screens/home.png",
      },
      {
        id: "state.home.video.normal",
        source: "state",
        kind: "video",
        path: "videos/session-01.webm",
      },
      {
        id: "state.home.video.key",
        source: "state",
        kind: "video",
        path: "videos/critical/session-02.webm",
      },
    ],
    gateResults: {
      status: "failed",
      checks: [
        {
          id: "page.error",
          expected: 0,
          actual: 1,
          severity: "BLOCKER",
          status: "failed",
          reasonCode: "gate.page_error.failed.threshold_exceeded",
          evidencePath: "logs/page-error.log",
        },
      ],
    },
  });

  const input = buildAiReviewInput(manifest, { maxArtifacts: 20 });
  const kinds = input.candidates.map((candidate) => candidate.kind);
  assert.ok(kinds.includes("video"));
  assert.ok(kinds.includes("screenshot"));
  assert.ok(kinds.includes("dom"));

  const keyVideo = input.candidates.find(
    (candidate) => candidate.path === "videos/critical/session-02.webm",
  );
  const normalVideo = input.candidates.find(
    (candidate) => candidate.path === "videos/session-01.webm",
  );
  const screenshot = input.candidates.find((candidate) => candidate.kind === "screenshot");
  const dom = input.candidates.find((candidate) => candidate.kind === "dom");

  assert.ok(keyVideo);
  assert.ok(normalVideo);
  assert.ok(screenshot);
  assert.ok(dom);
  assert.ok((keyVideo?.priority ?? 0) > (normalVideo?.priority ?? 0));
  assert.ok((normalVideo?.priority ?? 0) > (screenshot?.priority ?? 0));
  assert.ok((screenshot?.priority ?? 0) > (dom?.priority ?? 0));
});
