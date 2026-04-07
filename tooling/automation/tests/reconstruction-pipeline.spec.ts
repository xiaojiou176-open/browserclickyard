import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.resolve(
  AUTOMATION_ROOT,
  "..",
  ".runtime-cache",
  "test-output",
  "automation-recon",
);

test("reconstruction scripts generate canonical artifacts", async () => {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  mkdirSync(RUNTIME_ROOT, { recursive: true });

  const successHistoryDir = path.join(RUNTIME_ROOT, "history-success");
  const failureHistoryDir = path.join(RUNTIME_ROOT, "history-failure");
  const staleHistoryDir = path.join(RUNTIME_ROOT, "history-stale");
  const invalidHistoryDir = path.join(RUNTIME_ROOT, "history-invalid-attempted");
  mkdirSync(successHistoryDir, { recursive: true });
  mkdirSync(failureHistoryDir, { recursive: true });
  mkdirSync(staleHistoryDir, { recursive: true });
  mkdirSync(invalidHistoryDir, { recursive: true });
  writeFileSync(
    path.join(successHistoryDir, "run-readiness-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        replayAttempt: { attempted: true, success: true, status: "success" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    path.join(failureHistoryDir, "run-readiness-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        replayAttempt: { attempted: true, success: false, status: "failed" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    path.join(staleHistoryDir, "run-readiness-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
        replayAttempt: { attempted: true, success: true, status: "success" },
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    path.join(invalidHistoryDir, "run-readiness-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        replayAttempt: { attempted: "false", success: true, status: "success" },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const harPath = path.join(RUNTIME_ROOT, "register.har");
  writeFileSync(
    harPath,
    JSON.stringify(
      {
        log: {
          entries: [
            {
              startedDateTime: new Date().toISOString(),
              request: {
                method: "POST",
                url: "https://example.com/api/register",
                headers: [{ name: "Content-Type", value: "application/json" }],
                postData: {
                  mimeType: "application/json",
                  text: JSON.stringify({
                    email: "a@b.com",
                    password: "__REDACTED_TEST_PASSWORD__", // pragma: allowlist secret
                  }),
                },
              },
              response: { status: 201, headers: [] },
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  execFileSync(
    "pnpm",
    ["node", "--import", "tsx", "scripts/extract-flow-spec.ts", `--har=${harPath}`],
    {
      cwd: AUTOMATION_ROOT,
      stdio: "pipe",
    },
  );

  const canonicalPath = path.join(RUNTIME_ROOT, "flow_request.spec.json");
  const canonical = JSON.parse(readFileSync(canonicalPath, "utf-8")) as {
    registerEndpoint: { path: string };
  };
  expect(canonical.registerEndpoint.path).toBe("/api/register");

  const previewPath = path.join(RUNTIME_ROOT, "preview.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "prv_test",
        flow_draft: {
          start_url: "https://example.com/register",
          steps: [
            { step_id: "s1", action: "navigate", url: "https://example.com/register" },
            {
              step_id: "s2",
              action: "type",
              value_ref: "${params.email}",
              target: { selectors: [{ kind: "css", value: 'input[name="email"]', score: 91 }] },
            },
            {
              step_id: "s3",
              action: "click",
              target: {
                selectors: [{ kind: "role", value: "button[name='Create Account']", score: 88 }],
              },
            },
            {
              step_id: "s4",
              action: "manual_gate",
              unsupported_reason: "cloudflare captcha otp challenge with csrf token enforcement",
            },
            {
              step_id: "s5",
              action: "type",
              value_ref: "${params.email}",
              selected_selector_index: 99,
              target: { selectors: [{ kind: "name", value: "[name='email']", score: 85 }] },
            },
            {
              step_id: "s6",
              action: "manual_gate",
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  execFileSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/generate-from-reconstruction.ts",
      `--preview=${previewPath}`,
      `--outDir=${RUNTIME_ROOT}`,
    ],
    {
      cwd: AUTOMATION_ROOT,
      stdio: "pipe",
    },
  );

  const generatedPlaywrightPath = path.join(RUNTIME_ROOT, "generated-playwright.spec.ts");
  const generatedPlaywright = readFileSync(generatedPlaywrightPath, "utf-8");
  expect(generatedPlaywright).toContain("const FLOW_STEPS");
  expect(generatedPlaywright).toContain("await executeStep(page, step)");
  expect(generatedPlaywright).toContain('"step_id": "s3"');
  expect(generatedPlaywright).toContain(
    "throw new Error(`Missing required environment variable: ${name}`)",
  );
  expect(generatedPlaywright).toContain("email: `generated+${Date.now()}@example.com`");
  expect(generatedPlaywright).toContain("return page.locator(selector.value)");
  expect(generatedPlaywright).toContain("if (selector.value.startsWith('[name='))");
  expect(generatedPlaywright).toContain("step.selected_selector_index < step.selectors.length");
  expect(generatedPlaywright).toContain("if (!candidate) continue");
  expect(generatedPlaywright).toContain("selector not found for wait_for step");
  expect(generatedPlaywright).toContain("selector not found for assert step");
  expect(generatedPlaywright).not.toMatch(/await page\.waitForTimeout\(\d+\)/);
  expect(generatedPlaywright).not.toContain("await expect(page).toHaveURL(/.*/)");
  expect(generatedPlaywright).not.toContain('"selected_selector_index": 99');
  expect(generatedPlaywright).toContain('"selected_selector_index": null');

  const generatedApiPath = path.join(RUNTIME_ROOT, "generated-api.spec.ts");
  const generatedApi = readFileSync(generatedApiPath, "utf-8");
  expect(generatedApi).toContain("const ACTION_ENDPOINT");
  expect(generatedApi).toContain("generated api replay");

  const readinessPath = path.join(RUNTIME_ROOT, "run-readiness-report.json");
  const readiness = JSON.parse(readFileSync(readinessPath, "utf-8")) as {
    ready: boolean;
    apiReplayReady: boolean;
    requiredBootstrapSteps: number;
    replaySuccessRate7d: number | null;
    replaySuccessSamples7d: number;
    replaySla: {
      replaySuccesses7d: number;
      replaySuccessRate7d: number | null;
      replaySuccessSamples7d: number;
    };
    replayAttempt: {
      attempted: boolean;
      success: boolean | null;
      status: string;
    };
    manualGateReasons: string[];
    manualGateReasonMatrix: {
      counts: Record<"cloudflare" | "captcha" | "otp" | "csrf" | "token" | "unknown", number>;
      byStep: Array<{ stepId: string; reasonCodes: string[] }>;
    };
    manualGateStatsPanel: {
      totalManualGateSteps: number;
      totalReasonCodeHits: number;
      knownReasonCodeHits: number;
      unknownReasonCodeHits: number;
      dominantReasonCode: string | null;
    };
  };
  expect(readiness.ready).toBe(true);
  expect(readiness.apiReplayReady).toBe(true);
  expect(readiness.requiredBootstrapSteps).toBe(0);
  expect(readiness.replayAttempt).toEqual({
    attempted: false,
    success: null,
    status: "not_attempted",
  });
  expect(readiness.replaySuccessSamples7d).toBe(2);
  expect(readiness.replaySla.replaySuccessSamples7d).toBe(2);
  expect(readiness.replaySla.replaySuccesses7d).toBe(1);
  expect(readiness.replaySuccessRate7d).toBe(0.5);
  expect(readiness.replaySla.replaySuccessRate7d).toBe(0.5);
  expect(readiness.manualGateReasons).toEqual([
    "cloudflare captcha otp challenge with csrf token enforcement",
  ]);
  expect(readiness.manualGateReasonMatrix.byStep).toHaveLength(2);
  expect(readiness.manualGateReasonMatrix.counts.cloudflare).toBe(1);
  expect(readiness.manualGateReasonMatrix.counts.captcha).toBe(1);
  expect(readiness.manualGateReasonMatrix.counts.otp).toBe(1);
  expect(readiness.manualGateReasonMatrix.counts.csrf).toBe(1);
  expect(readiness.manualGateReasonMatrix.counts.token).toBe(1);
  expect(readiness.manualGateReasonMatrix.counts.unknown).toBe(1);
  expect(readiness.manualGateStatsPanel.totalManualGateSteps).toBe(2);
  expect(readiness.manualGateStatsPanel.totalReasonCodeHits).toBe(6);
  expect(readiness.manualGateStatsPanel.knownReasonCodeHits).toBe(5);
  expect(readiness.manualGateStatsPanel.unknownReasonCodeHits).toBe(1);
  expect(readiness.manualGateStatsPanel.dominantReasonCode).toBe("cloudflare");
});

test("reconstruction script rejects invalid preview shape with explicit error", async () => {
  const outputDir = path.join(RUNTIME_ROOT, `invalid-preview-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const previewPath = path.join(outputDir, "preview-invalid.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "invalid-shape",
        flow_draft: {
          start_url: "https://example.com/register",
          steps: "not-an-array",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/generate-from-reconstruction.ts",
      `--preview=${previewPath}`,
      `--outDir=${outputDir}`,
    ],
    { cwd: AUTOMATION_ROOT, encoding: "utf-8" },
  );
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("invalid preview: flow_draft.steps must be an array");
});

test("reconstruction script rejects non-http start_url", async () => {
  const outputDir = path.join(RUNTIME_ROOT, `invalid-preview-url-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const previewPath = path.join(outputDir, "preview-invalid-url.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "invalid-url",
        flow_draft: {
          start_url: "mailto:security@example.com",
          steps: [],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/generate-from-reconstruction.ts",
      `--preview=${previewPath}`,
      `--outDir=${outputDir}`,
    ],
    { cwd: AUTOMATION_ROOT, encoding: "utf-8" },
  );
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain(
    "invalid preview: flow_draft.start_url must be an absolute http/https URL",
  );
});

test("reconstruction script rejects cross-origin replay endpoints", async () => {
  const outputDir = path.join(RUNTIME_ROOT, `invalid-cross-origin-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const previewPath = path.join(outputDir, "preview-cross-origin.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "cross-origin",
        flow_draft: {
          start_url: "https://example.com/register",
          action_endpoint: {
            method: "POST",
            fullUrl: "https://evil.example.net/api/register",
            path: "/api/register",
            contentType: "application/json",
          },
          steps: [],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/generate-from-reconstruction.ts",
      `--preview=${previewPath}`,
      `--outDir=${outputDir}`,
    ],
    { cwd: AUTOMATION_ROOT, encoding: "utf-8" },
  );
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain(
    "action_endpoint.fullUrl must match start_url origin https://example.com",
  );
});

test("reconstruction script sanitizes preview_id for default output directory", async () => {
  const sandboxDir = path.join(RUNTIME_ROOT, `path-sanitize-${Date.now()}`);
  mkdirSync(sandboxDir, { recursive: true });
  const previewPath = path.join(sandboxDir, "preview-path-traversal.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "../../outside/../evil:*id",
        flow_draft: {
          start_url: "https://example.com/register",
          steps: [{ step_id: "s1", action: "navigate", url: "https://example.com/register" }],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const run = spawnSync(
    "pnpm",
    [
      "node",
      "--import",
      "tsx",
      "scripts/generate-from-reconstruction.ts",
      `--preview=${previewPath}`,
    ],
    { cwd: AUTOMATION_ROOT, encoding: "utf-8" },
  );
  expect(run.status).toBe(0);
  const output = JSON.parse(run.stdout) as { flowPath: string };
  const generatedDir = path.dirname(output.flowPath);
  const defaultRoot = path.join(AUTOMATION_ROOT, "tests", "generated");
  const relative = path.relative(defaultRoot, generatedDir);
  expect(
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
  ).toBe(false);
  expect(path.basename(generatedDir)).toBe("_.._outside_.._evil_id");
  rmSync(generatedDir, { recursive: true, force: true });
});
