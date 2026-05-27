import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "automation-secret-guards",
);
const FLOW_RUNTIME_ROOT = path.resolve(AUTOMATION_ROOT, "..", ".runtime-cache", "automation");

test("generate-from-reconstruction emits secret guards without weak password defaults", async () => {
  const outputDir = path.join(
    RUNTIME_ROOT,
    `recon-${randomUUID()}`,
  );
  mkdirSync(outputDir, { recursive: true });

  const previewPath = path.join(outputDir, "preview.json");
  writeFileSync(
    previewPath,
    JSON.stringify(
      {
        preview_id: "secret_guard_preview",
        flow_draft: {
          start_url: "https://example.com/register",
          steps: [
            { step_id: "s1", action: "navigate", url: "https://example.com/register" },
            {
              step_id: "s2",
              action: "type",
              value_ref: "${secrets.password}",
              target: { selectors: [{ kind: "css", value: 'input[name="password"]', score: 98 }] },
            },
          ],
          payload_example: {
            email: "${params.email}",
            password: "${secrets.password}",
          },
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
  expect(run.status).toBe(0);

  const playwrightSpec = readFileSync(
    path.join(outputDir, "generated-playwright.spec.ts"),
    "utf-8",
  );
  const apiSpec = readFileSync(path.join(outputDir, "generated-api.spec.ts"), "utf-8");
  const merged = `${playwrightSpec}\n${apiSpec}`;

  expect(merged).not.toContain("ChangeMe123!");
  expect(merged).not.toContain("S3cretPass!");
  expect(merged).toContain("missing secret input for");
});

test("replay-flow-draft fails fast when secret input is missing", async () => {
  const sessionId = `secret-missing-${randomUUID()}`;
  const sessionDir = path.join(FLOW_RUNTIME_ROOT, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const startUrl = `data:text/html,${encodeURIComponent('<html><body><input name="password" /></body></html>')}`;
  writeFileSync(
    path.join(sessionDir, "flow-draft.json"),
    JSON.stringify(
      {
        flow_id: `flow-${sessionId}`,
        session_id: sessionId,
        start_url: startUrl,
        steps: [
          { step_id: "s1", action: "navigate", url: startUrl },
          {
            step_id: "s2",
            action: "type",
            value_ref: "${secrets.password}",
            target: {
              selectors: [{ kind: "name", value: "password", score: 99 }],
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    path.join(FLOW_RUNTIME_ROOT, "latest-session.json"),
    JSON.stringify({ sessionDir, sessionId }, null, 2),
    "utf-8",
  );

  const run = spawnSync("pnpm", ["node", "--import", "tsx", "scripts/replay-flow-draft.ts"], {
    cwd: AUTOMATION_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      FLOW_SECRET_INPUT: "",
      REGISTER_PASSWORD: "",
      HEADLESS: "true",
    },
  });

  expect(run.status).not.toBe(0);
  const result = JSON.parse(
    readFileSync(path.join(sessionDir, "replay-flow-result.json"), "utf-8"),
  ) as {
    status: string;
    success: boolean;
    stepResults: Array<{ step_id: string; ok: boolean; detail: string }>;
  };
  expect(result.status).toBe("failed");
  expect(result.success).toBe(false);
  const failed = result.stepResults.find((item) => item.step_id === "s2");
  expect(failed?.ok).toBe(false);
  expect(failed?.detail).toContain("missing secret input");
});
