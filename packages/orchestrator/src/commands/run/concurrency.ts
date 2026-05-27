import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORCHESTRATOR_ENV } from "../env.js";
import type { TestSuiteResult } from "../test-suite.js";
import { DEFAULT_MAX_PARALLEL_TASKS } from "./config.js";

export type ConcurrentTask = (signal: AbortSignal) => Promise<void>;

export function resolveMaxParallelTasks(): number {
  return DEFAULT_MAX_PARALLEL_TASKS;
}

function tailCommandOutput(text: string, maxLines = 60): string {
  return text.split("\n").slice(-maxLines).join("\n").trim();
}

function argsForSuite(
  suite: "unit" | "ct" | "e2e" | "contract",
  e2eSuite: "smoke" | "regression" | "generic" | "full",
): string[] {
  if (suite === "unit") {
    return ["test:unit"];
  }
  if (suite === "contract") {
    return ["test:contract"];
  }
  if (suite === "ct") {
    return ["test:ct"];
  }
  if (e2eSuite === "smoke") {
    return ["test:e2e", "--grep", "@smoke"];
  }
  if (e2eSuite === "regression") {
    return ["test:e2e", "--grep", "@regression"];
  }
  if (e2eSuite === "generic") {
    return ["test:e2e", "--grep", "@generic"];
  }
  return ["test:e2e"];
}

function computeIsolatedCtPort(baseDir: string): number {
  let hash = 0;
  for (const ch of baseDir) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return 4300 + (hash % 200);
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return new Error(reason);
  }
  return new Error("execution_cancelled");
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw abortReasonToError(signal.reason);
}

export async function runWithConcurrencyLimit(
  tasks: ConcurrentTask[],
  maxParallel: number,
): Promise<void> {
  if (tasks.length === 0) {
    return;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let firstError: unknown;
  const abortFromError = (error: unknown): void => {
    if (firstError !== undefined) {
      return;
    }
    firstError = error;
    controller.abort(abortReasonToError(error));
  };
  let nextIndex = 0;
  const workerCount = Math.min(tasks.length, Math.max(1, maxParallel));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (signal.aborted) {
        return;
      }
      const currentIndex = nextIndex++;
      if (currentIndex >= tasks.length) {
        return;
      }
      throwIfAborted(signal);
      try {
        await tasks[currentIndex](signal);
      } catch (error) {
        abortFromError(error);
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError !== undefined) {
    throw abortReasonToError(firstError);
  }
}

export async function runTestSuiteAsync(
  baseDir: string,
  suite: "unit" | "contract" | "ct" | "e2e",
  baseUrl?: string,
  e2eSuite: "smoke" | "regression" | "generic" | "full" = "smoke",
): Promise<TestSuiteResult> {
  const started = Date.now();
  const args = argsForSuite(suite, e2eSuite);
  const reportPath = `reports/test-${suite}.json`;
  const ctPort = suite === "ct" ? computeIsolatedCtPort(baseDir) : undefined;
  const env = {
    ...ORCHESTRATOR_ENV,
    ...(baseUrl ? { BASE_URL: baseUrl, UIQ_BASE_URL: baseUrl } : {}),
    ...(ctPort ? { UIQ_CT_PORT: String(ctPort), UIQ_CT_HOST: "127.0.0.1" } : {}),
  };

  const result = await new Promise<TestSuiteResult>((resolvePromise) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const failed: TestSuiteResult = {
        suite,
        status: "failed",
        exitCode: 1,
        durationMs: Date.now() - started,
        command: "pnpm",
        args,
        reportPath,
        stdoutTail: tailCommandOutput(stdout),
        stderrTail: tailCommandOutput(`${stderr}\n${error.message}`),
      };
      resolvePromise(failed);
    });
    child.on("close", (code) => {
      const done: TestSuiteResult = {
        suite,
        status: code === 0 ? "passed" : "failed",
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        command: "pnpm",
        args,
        reportPath,
        stdoutTail: tailCommandOutput(stdout),
        stderrTail: tailCommandOutput(stderr),
      };
      resolvePromise(done);
    });
  });

  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}
