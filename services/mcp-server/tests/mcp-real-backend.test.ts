// @ts-nocheck
// 
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { callToolJson, startMcpHarnessDefault } from "./helpers/mcp-client.js";

const workspaceRoot = resolve(import.meta.dirname, "fixtures/workspace");
const realBackendEnabled = /^(1|true|yes|on)$/i.test(
  process.env.UIQ_ENABLE_REAL_BACKEND_TESTS ?? "",
);

type SessionPayload = {
  session_id: string;
  start_url: string;
  mode: "manual" | "ai";
  finished_at: string | null;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("unable to reserve a local port for real backend test");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForBackendReady(
  baseUrl: string,
  proc: ChildProcessWithoutNullStreams,
  logs: () => string,
  spawnError: () => Error | null,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const launchError = spawnError();
    if (launchError) {
      throw new Error(`real backend failed to launch: ${launchError.message}\n${logs()}`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`real backend exited before ready (exit=${proc.exitCode})\n${logs()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/`);
      if (res.ok) {
        return;
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  throw new Error(`timed out waiting for real backend health endpoint: ${baseUrl}/health/`);
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  proc.kill("SIGTERM");
  const exited = once(proc, "exit");
  const timeout = new Promise<void>((resolveTimeout) => {
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
      resolveTimeout();
    }, 5_000);
  });
  await Promise.race([exited, timeout]);
}

test(
  "mcp real backend: sessions start/list/finish against FastAPI uvicorn",
  { timeout: 120_000, skip: !realBackendEnabled },
  async () => {
    const runtimeRoot = mkdtempSync(resolve(tmpdir(), "uiq-mcp-real-backend-"));
    const universalDataDir = resolve(runtimeRoot, "universal-data");
    const universalRuntimeDir = resolve(runtimeRoot, "universal-runtime");
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let launchError: Error | null = null;
    let stdoutTail = "";
    let stderrTail = "";

    const backendProc = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "--extra",
        "dev",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        stdio: "pipe",
        env: {
          ...process.env,
          AUTOMATION_REQUIRE_TOKEN: "false",
          AUTOMATION_ALLOW_LOCAL_NO_TOKEN: "true",
          UNIVERSAL_PLATFORM_DATA_DIR: universalDataDir,
          UNIVERSAL_AUTOMATION_RUNTIME_DIR: universalRuntimeDir,
        },
      },
    );
    backendProc.on("error", (error) => {
      launchError = error;
    });
    backendProc.stdout.on("data", (chunk: Buffer | string) => {
      stdoutTail = `${stdoutTail}${chunk.toString()}`.slice(-8_000);
    });
    backendProc.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-8_000);
    });

    const harness = await startMcpHarnessDefault({
      workspaceRoot,
      env: {
        UIQ_MCP_API_BASE_URL: baseUrl,
      },
    });

    try {
      await waitForBackendReady(
        baseUrl,
        backendProc,
        () => [stdoutTail.trim(), stderrTail.trim()].filter(Boolean).join("\n"),
        () => launchError,
      );

      const started = await callToolJson<{ ok: boolean; action: string; payload: SessionPayload }>(
        harness.client,
        "uiq_api_sessions",
        {
          action: "start",
          startUrl: "https://example.com/register",
          mode: "manual",
        },
      );
      assert.equal(started.isError, false);
      assert.equal(started.data.ok, true);
      assert.equal(started.data.action, "start");
      assert.match(started.data.payload.session_id, /^ss_/);
      assert.equal(started.data.payload.start_url, "https://example.com/register");
      assert.equal(started.data.payload.mode, "manual");
      assert.equal(started.data.payload.finished_at, null);

      const listedBeforeFinish = await callToolJson<{
        ok: boolean;
        action: string;
        payload: SessionPayload[];
      }>(harness.client, "uiq_api_sessions", {
        action: "list",
        limit: 10,
      });
      assert.equal(listedBeforeFinish.isError, false);
      assert.equal(listedBeforeFinish.data.ok, true);
      assert.equal(listedBeforeFinish.data.action, "list");
      assert.ok(listedBeforeFinish.data.payload.length >= 1);
      assert.ok(
        listedBeforeFinish.data.payload.some(
          (item) => item.session_id === started.data.payload.session_id,
        ),
      );

      const finished = await callToolJson<{ ok: boolean; action: string; payload: SessionPayload }>(
        harness.client,
        "uiq_api_sessions",
        {
          action: "finish",
          sessionId: started.data.payload.session_id,
        },
      );
      assert.equal(finished.isError, false);
      assert.equal(finished.data.ok, true);
      assert.equal(finished.data.action, "finish");
      assert.equal(finished.data.payload.session_id, started.data.payload.session_id);
      assert.ok(
        typeof finished.data.payload.finished_at === "string" &&
          finished.data.payload.finished_at.length > 0,
      );

      const listedAfterFinish = await callToolJson<{ ok: boolean; payload: SessionPayload[] }>(
        harness.client,
        "uiq_api_sessions",
        {
          action: "list",
          limit: 10,
        },
      );
      const finishedSession = listedAfterFinish.data.payload.find(
        (item) => item.session_id === started.data.payload.session_id,
      );
      assert.ok(finishedSession, "finished session should still be listable from real backend");
      assert.ok(
        typeof finishedSession.finished_at === "string" && finishedSession.finished_at.length > 0,
      );

      const sessionsData = JSON.parse(
        readFileSync(resolve(universalDataDir, "sessions.json"), "utf8"),
      ) as SessionPayload[];
      assert.ok(Array.isArray(sessionsData));
      assert.ok(sessionsData.some((item) => item.session_id === started.data.payload.session_id));
    } finally {
      await harness.close();
      await stopProcess(backendProc);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  },
);
