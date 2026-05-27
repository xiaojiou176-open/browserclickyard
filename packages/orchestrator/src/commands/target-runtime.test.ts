import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTargetConfig } from "./run/config.js";
import { parseCommandString, startTargetRuntime, waitForHealthcheck } from "./target-runtime.js";

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return condition();
}

test("parseCommandString tokenizes quoted args and blocks shell operators", () => {
  const parsed = parseCommandString('node -e "console.log(1)"');
  assert.equal(parsed.command, "node");
  assert.deepEqual(parsed.args, ["-e", "console.log(1)"]);

  assert.throws(() => parseCommandString("pnpm uiq && rm -rf /"), /unsupported shell operators/);
});

test("web.ci runtime command stays shell-safe and aligned with runtime URL config", () => {
  const target = loadTargetConfig("web.ci");
  const baseUrl = target.baseUrl;
  const healthcheckUrl = target.healthcheck?.url;
  const webStartCommand = target.start?.web;

  assert.ok(baseUrl, "web.ci must define baseUrl");
  assert.ok(healthcheckUrl, "web.ci must define healthcheck.url");
  assert.ok(webStartCommand, "web.ci must define start.web");

  const parsedBaseUrl = new URL(baseUrl);
  const parsedHealthcheckUrl = new URL(healthcheckUrl);
  const parsedCommand = parseCommandString(webStartCommand);
  const wrapperScriptPath = resolve("scripts/start-web-ci-runtime.mjs");
  const wrapperSource = readFileSync(wrapperScriptPath, "utf8");
  const defaultPortMatch = wrapperSource.match(/const DEFAULT_PORT = (\d+);/u);

  assert.equal(parsedCommand.command, "node", "start.web should use node wrapper entry");
  assert.ok(
    parsedCommand.args.includes("scripts/start-web-ci-runtime.mjs"),
    "start.web should delegate runtime boot to start-web-ci-runtime wrapper",
  );
  assert.match(
    parsedBaseUrl.port,
    /^4417\d$/u,
    "web runtime baseUrl should stay in dedicated 4417x range",
  );
  assert.ok(defaultPortMatch?.[1], "wrapper should declare a numeric DEFAULT_PORT");
  assert.equal(
    defaultPortMatch?.[1],
    parsedBaseUrl.port,
    "wrapper DEFAULT_PORT should align with web.ci baseUrl port",
  );
  assert.equal(
    parsedHealthcheckUrl.port,
    parsedBaseUrl.port,
    "healthcheck.url port should align with baseUrl port",
  );
});

test("startTargetRuntime rejects non-allowlisted executable", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: {
          web: "curl http://127.0.0.1:4173",
        },
      }),
    /not allowlisted/,
  );
});

test("startTargetRuntime redacts sensitive command args in report", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  const result = await startTargetRuntime({
    enabled: true,
    baseDir,
    startCommands: {
      web: "pnpm --token super-secret run dev",
    },
  });
  try {
    assert.equal(result.started, true);
    assert.match(result.processes[0]?.command ?? "", /--token \*\*\*/);
    assert.doesNotMatch(result.processes[0]?.command ?? "", /super-secret/);
  } finally {
    await result.teardown();
  }
});

test("startTargetRuntime rejects executable paths with separators", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: {
          web: "../evil/pnpm run dev",
        },
      }),
    /path separators are not allowed/,
  );
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: {
          web: "tmp/fake/pnpm run dev",
        },
      }),
    /path separators are not allowed/,
  );
});

test("startTargetRuntime rejects executable outside trusted dirs", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  const fakeBinDir = mkdtempSync(join(tmpdir(), "uiq-bin-"));
  const fakePnpm = join(fakeBinDir, "pnpm");
  writeFileSync(fakePnpm, "#!/usr/bin/env bash\necho fake-pnpm\n", "utf8");
  chmodSync(fakePnpm, 0o755);

  const originalPath = process.env.PATH;
  const originalTrusted = process.env.UIQ_TRUSTED_BIN_DIRS;
  process.env.PATH = fakeBinDir;
  process.env.UIQ_TRUSTED_BIN_DIRS = "/usr/bin,/bin";
  try {
    await assert.rejects(
      () =>
        startTargetRuntime({
          enabled: true,
          baseDir,
          startCommands: {
            web: "pnpm --version",
          },
        }),
      /not under trusted directories/,
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalTrusted === undefined) {
      delete process.env.UIQ_TRUSTED_BIN_DIRS;
    } else {
      process.env.UIQ_TRUSTED_BIN_DIRS = originalTrusted;
    }
  }
});

test("startTargetRuntime blocks shell-style command operators", async () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "uiq-target-runtime-"));
  mkdirSync(resolve(tempRoot, "reports"), { recursive: true });

  try {
    await assert.rejects(
      startTargetRuntime({
        enabled: true,
        baseDir: tempRoot,
        startCommands: { web: "pnpm uiq && rm -rf /" },
      }),
      /unsupported shell operators/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startTargetRuntime healthcheck polls until receiving an accepted status", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  let requestCount = 0;
  const keepAliveScript = join(baseDir, "keepalive.js");
  writeFileSync(keepAliveScript, "setInterval(() => {}, 1000);\n", "utf8");

  const server = createServer((_, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.end("ok");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const healthcheckUrl = `http://127.0.0.1:${address.port}/health`;

  const result = await startTargetRuntime({
    enabled: true,
    baseDir,
    startCommands: { web: `node ${keepAliveScript}` },
    healthcheckUrl,
  });
  try {
    assert.equal(result.healthcheckPassed, true);
    assert.equal(result.healthcheckReason, "healthcheck_passed");
    assert.ok(requestCount >= 2, "healthcheck should continue polling after 404");
  } finally {
    await result.teardown();
    server.close();
  }
});

test("startTargetRuntime treats 401 healthcheck as acceptable runtime readiness", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  const keepAliveScript = join(baseDir, "keepalive.js");
  writeFileSync(keepAliveScript, "setInterval(() => {}, 1000);\n", "utf8");

  const server = createServer((_, response) => {
    response.statusCode = 401;
    response.end("auth required");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const healthcheckUrl = `http://127.0.0.1:${address.port}/health`;

  const result = await startTargetRuntime({
    enabled: true,
    baseDir,
    startCommands: { web: `node ${keepAliveScript}` },
    healthcheckUrl,
  });
  try {
    assert.equal(result.healthcheckPassed, true);
    assert.equal(result.healthcheckReason, "healthcheck_passed");
    assert.equal(result.healthcheckDetail, "received_http_401");
  } finally {
    await result.teardown();
    server.close();
  }
});

test("waitForHealthcheck aborts individual requests while preserving total timeout", async (t) => {
  let seenAbort = false;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = ((_: string, init?: RequestInit) => {
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => {
        seenAbort = true;
        reject(new Error("aborted"));
      });
    });
  }) as typeof fetch;

  const result = await waitForHealthcheck("http://127.0.0.1:9999/health", 120);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "healthcheck_request_error");
  assert.match(result.detail, /aborted/);
  assert.equal(seenAbort, true);
});

test("startTargetRuntime fails healthcheck when spawned process exits during stability window", async () => {
  const server = createServer((_, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", () => resolveReady()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const healthcheckUrl = `http://127.0.0.1:${address.port}/health`;

  const tempRoot = mkdtempSync(resolve(tmpdir(), "uiq-target-runtime-stability-"));
  mkdirSync(resolve(tempRoot, "reports"), { recursive: true });
  const earlyExitScript = resolve(tempRoot, "exit-early.js");
  writeFileSync(earlyExitScript, "setTimeout(() => process.exit(0), 200);\n", "utf8");

  try {
    const result = await startTargetRuntime({
      enabled: true,
      baseDir: tempRoot,
      startCommands: {
        web: `node ${earlyExitScript}`,
      },
      healthcheckUrl,
    });
    assert.equal(result.started, true);
    assert.equal(result.healthcheckPassed, false);
    assert.equal(result.healthcheckReason, "process_exited_during_stability_window");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("startTargetRuntime tears down already-started process when later startup command fails", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-partial-start-"));
  const apiScript = resolve(baseDir, "api-keepalive.mjs");
  writeFileSync(
    apiScript,
    `
      process.on("SIGTERM", () => {
        setTimeout(() => process.exit(0), 20);
      });
      setInterval(() => {}, 200);
    `,
    "utf8",
  );

  try {
    await assert.rejects(
      () =>
        startTargetRuntime({
          enabled: true,
          baseDir,
          startCommands: {
            api: `node ${apiScript}`,
            web: "curl http://127.0.0.1:4173",
          },
        }),
      /not allowlisted/,
    );

    const failedRuntimeReport = JSON.parse(
      readFileSync(resolve(baseDir, "reports/runtime-start.json"), "utf8"),
    ) as {
      processes: Array<{ pid: number }>;
      healthcheckReason?: string;
    };
    const pid = failedRuntimeReport.processes[0]?.pid ?? -1;
    assert.ok(Number.isFinite(pid), "api PID should be recorded before startup failure");
    assert.equal(failedRuntimeReport.healthcheckReason, "startup_command_failed");
    assert.equal(
      await waitForCondition(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 3_000),
      true,
      "api process should be terminated after startup rollback",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("awaited teardown releases old runtime before same-port restart", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-restart-await-"));
  const runtimeScript = resolve(baseDir, "slow-shutdown-runtime.mjs");
  const shutdownDelayMs = 900;

  const probe = createServer();
  await new Promise<void>((resolveReady) => probe.listen(0, "127.0.0.1", () => resolveReady()));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const runtimePort = address.port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));

  writeFileSync(
    runtimeScript,
    `
      import { createServer } from "node:http";
      const port = Number(process.argv[2] ?? "0");
      const shutdownDelayMs = Number(process.argv[3] ?? "0");
      const server = createServer((_, res) => {
        res.statusCode = 200;
        res.end("ok");
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => {
        setTimeout(() => {
          server.close(() => process.exit(0));
        }, shutdownDelayMs);
      });
      setInterval(() => {}, 1000);
    `,
    "utf8",
  );

  const healthcheckUrl = `http://127.0.0.1:${runtimePort}/health`;
  const startCommand = `node ${runtimeScript} ${runtimePort} ${shutdownDelayMs}`;

  let secondStart: Awaited<ReturnType<typeof startTargetRuntime>> | undefined;
  try {
    const firstStart = await startTargetRuntime({
      enabled: true,
      baseDir,
      startCommands: { web: startCommand },
      healthcheckUrl,
    });
    assert.equal(firstStart.healthcheckPassed, true);

    const teardownStartedAt = Date.now();
    await firstStart.teardown();
    const teardownElapsedMs = Date.now() - teardownStartedAt;
    assert.ok(
      teardownElapsedMs >= shutdownDelayMs - 100,
      `teardown should wait for graceful shutdown (elapsed=${teardownElapsedMs}ms)`,
    );

    secondStart = await startTargetRuntime({
      enabled: true,
      baseDir,
      startCommands: { web: startCommand },
      healthcheckUrl,
    });
    assert.equal(secondStart.healthcheckPassed, true);
  } finally {
    if (secondStart) {
      await secondStart.teardown();
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("target runtime teardown escalates to SIGKILL when process ignores SIGTERM", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-kill-fallback-"));
  const pidFile = resolve(baseDir, "ignore-term.pid");
  const termFile = resolve(baseDir, "ignore-term.sigterm");
  const script = resolve(baseDir, "ignore-sigterm.mjs");
  writeFileSync(
    script,
    `
      import { writeFileSync } from "node:fs";
      const [pidPath, sigtermPath] = process.argv.slice(2);
      writeFileSync(pidPath, String(process.pid), "utf8");
      process.on("SIGTERM", () => {
        writeFileSync(sigtermPath, "seen", "utf8");
      });
      setInterval(() => {}, 200);
    `,
    "utf8",
  );

  let pid: number | undefined;
  try {
    const result = await startTargetRuntime({
      enabled: true,
      baseDir,
      startCommands: {
        web: `node ${script} ${pidFile} ${termFile}`,
      },
    });
    pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    await result.teardown();

    assert.equal(
      await waitForCondition(() => existsSync(termFile), 3_000),
      true,
      "teardown should send SIGTERM first",
    );
    assert.equal(
      await waitForCondition(() => {
        if (!Number.isFinite(pid)) {
          return false;
        }
        try {
          process.kill(pid as number, 0);
          return false;
        } catch {
          return true;
        }
      }, 4_000),
      true,
      "teardown should SIGKILL process if SIGTERM does not stop it",
    );
  } finally {
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid as number, "SIGKILL");
      } catch {
        // process already stopped
      }
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});
