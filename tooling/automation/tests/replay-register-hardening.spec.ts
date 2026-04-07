import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTOMATION_ROOT = path.resolve(__dirname, "..");

function writeSpec(spec: unknown): { specPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "replay-register-hardening-"));
  const specPath = path.join(dir, "request-spec.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf-8");
  return {
    specPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type ReplayRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runReplayRegister(specPath: string): Promise<ReplayRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["node", "--import", "tsx", "scripts/replay-register.ts", `--spec=${specPath}`],
      {
        cwd: AUTOMATION_ROOT,
        env: {
          ...process.env,
          REPLAY_PASSWORD: "Aa1!ReplayPass_123", // pragma: allowlist secret
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test("rejects cross-origin replay endpoint", async () => {
  const { specPath, cleanup } = writeSpec({
    baseUrl: "https://example.com",
    actionEndpoint: {
      method: "POST",
      fullUrl: "https://evil.example/register",
      path: "/register",
      contentType: "application/json",
    },
    payloadExample: {
      email: "demo@example.com",
      password: "***REDACTED***",
    },
  });

  try {
    const run = await runReplayRegister(specPath);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("same-origin");
  } finally {
    cleanup();
  }
});

test("strips sensitive static headers from replay request", async () => {
  let capturedHeaders: http.IncomingHttpHeaders | null = null;
  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate replay hardening test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { specPath, cleanup } = writeSpec({
    baseUrl,
    actionEndpoint: {
      method: "GET",
      path: "/capture",
    },
    requiredHeaders: {
      Authorization: "Bearer should-not-be-sent",
      Referer: "https://evil.example/path",
      "X-Test-Trace": "allowed-header",
    },
    payloadExample: {},
  });

  try {
    const run = await runReplayRegister(specPath);
    expect(run.status, `${run.stderr || run.stdout || "replay-register failed"}`).toBe(0);
    if (!capturedHeaders) {
      throw new Error("expected replay hardening server to capture request headers");
    }
    const observedHeaders = capturedHeaders as http.IncomingHttpHeaders;
    expect(observedHeaders.authorization).toBeUndefined();
    expect(observedHeaders.referer).toBeUndefined();
    expect(observedHeaders["x-test-trace"]).toBe("allowed-header");
  } finally {
    cleanup();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
