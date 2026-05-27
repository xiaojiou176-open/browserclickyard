// @ts-nocheck
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORCHESTRATOR_ENV } from "./env.js";

export type TestSuiteId = "unit" | "ct" | "e2e" | "contract";
export type E2ESuite = "smoke" | "regression" | "generic" | "full";

export type TestSuiteResult = {
  suite: TestSuiteId;
  status: "passed" | "failed";
  exitCode: number;
  durationMs: number;
  command: string;
  args: string[];
  reportPath: string;
  stdoutTail: string;
  stderrTail: string;
};

function tail(text: string, maxLines = 60): string {
  return text.split("\n").slice(-maxLines).join("\n").trim();
}

function argsForSuite(suite: TestSuiteId, e2eSuite: E2ESuite): string[] {
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
  // Keep CT ports in a dedicated range to avoid collisions with web/e2e ports.
  let hash = 0;
  for (const ch of baseDir) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return 4300 + (hash % 200);
}

export function runTestSuite(
  baseDir: string,
  suite: TestSuiteId,
  baseUrl?: string,
  e2eSuite: E2ESuite = "smoke",
): TestSuiteResult {
  const started = Date.now();
  const args = argsForSuite(suite, e2eSuite);
  const ctPort = suite === "ct" ? computeIsolatedCtPort(baseDir) : undefined;
  const proc = spawnSync("pnpm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...ORCHESTRATOR_ENV,
      ...(baseUrl ? { BASE_URL: baseUrl, UIQ_BASE_URL: baseUrl } : {}),
      ...(ctPort ? { UIQ_CT_PORT: String(ctPort), UIQ_CT_HOST: "127.0.0.1" } : {}),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const status = proc.status === 0 ? "passed" : "failed";
  const reportPath = `reports/test-${suite}.json`;

  const result: TestSuiteResult = {
    suite,
    status,
    exitCode: proc.status ?? 1,
    durationMs,
    command: "pnpm",
    args,
    reportPath,
    stdoutTail: tail(proc.stdout ?? ""),
    stderrTail: tail(proc.stderr ?? ""),
  };

  writeFileSync(resolve(baseDir, reportPath), JSON.stringify(result, null, 2), "utf8");
  return result;
}
