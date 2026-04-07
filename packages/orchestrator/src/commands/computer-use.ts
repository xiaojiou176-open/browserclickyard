import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type ComputerUseOptions = {
  task: string;
  maxSteps?: number;
  speedMode?: boolean;
  runId?: string;
};

export type NormalizedComputerUseOptions = {
  task: string;
  maxSteps: number;
  speedMode: boolean;
  runId?: string;
};

export type ComputerUseExecutionResult = {
  status: "ok" | "failed";
  reason: string;
  exitCode: number;
  command: string;
  args: string[];
  scriptPath: string;
  stdoutTail: string;
  stderrTail: string;
  computerUseSafetyConfirmations: number;
  safetyConfirmationEvidence?: {
    events: Array<Record<string, unknown>>;
  };
  error?: string;
};

export type RunComputerUseDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scriptPath?: string;
  pythonBin?: string;
  spawnSyncImpl?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
      maxBuffer: number;
      input: string;
    },
  ) => SpawnSyncReturns<string>;
};

const DEFAULT_MAX_STEPS = 50;
const REASON_CODE_PREFIX = "COMPUTER_USE_REASON_CODE=";
const SAFETY_SUMMARY_PREFIX = "COMPUTER_USE_SAFETY_SUMMARY=";

function tail(text: string | NodeJS.ArrayBufferView | null | undefined, maxLines = 60): string {
  const normalized =
    typeof text === "string"
      ? text
      : text
        ? Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8")
        : "";
  return normalized.split("\n").slice(-maxLines).join("\n").trim();
}

function normalizeTextOutput(text: string | NodeJS.ArrayBufferView | null | undefined): string {
  if (typeof text === "string") {
    return text;
  }
  if (!text) {
    return "";
  }
  return Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8");
}

function extractReasonCode(
  ...outputs: Array<string | NodeJS.ArrayBufferView | null | undefined>
): string | undefined {
  for (const output of outputs) {
    const normalized = normalizeTextOutput(output);
    if (!normalized) {
      continue;
    }
    const lines = normalized.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (line.startsWith(REASON_CODE_PREFIX)) {
        const code = line.slice(REASON_CODE_PREFIX.length).trim();
        if (code.length > 0) {
          return code;
        }
      }
    }
  }
  return undefined;
}

function extractSafetySummary(
  ...outputs: Array<string | NodeJS.ArrayBufferView | null | undefined>
): {
  count: number;
  events: Array<Record<string, unknown>>;
} {
  for (const output of outputs) {
    const normalized = normalizeTextOutput(output);
    if (!normalized) {
      continue;
    }
    const lines = normalized.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith(SAFETY_SUMMARY_PREFIX)) {
        continue;
      }
      const raw = line.slice(SAFETY_SUMMARY_PREFIX.length).trim();
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as {
          computerUseSafetyConfirmations?: unknown;
          events?: unknown;
        };
        const count = Number(parsed.computerUseSafetyConfirmations);
        const events = Array.isArray(parsed.events)
          ? (parsed.events as Array<Record<string, unknown>>)
          : [];
        return {
          count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : events.length,
          events,
        };
      } catch {
        return { count: 0, events: [] };
      }
    }
  }
  return { count: 0, events: [] };
}

export function normalizeComputerUseOptions(
  options: ComputerUseOptions,
): NormalizedComputerUseOptions {
  const task = options.task?.trim() ?? "";
  if (task.length === 0) {
    throw new Error("Invalid --task: value is required");
  }

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000) {
    throw new Error(`Invalid --max-steps: expected integer in [1, 10000], got ${maxSteps}`);
  }

  return {
    task,
    maxSteps,
    speedMode: options.speedMode === true,
    runId: options.runId?.trim() ? options.runId.trim() : undefined,
  };
}

export function buildComputerUseEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: NormalizedComputerUseOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    AI_MAX_STEPS: String(options.maxSteps),
  };

  if (options.runId) {
    env.AI_RUN_ID = options.runId;
  } else {
    delete env.AI_RUN_ID;
  }

  if (options.speedMode) {
    env.AI_SPEED_MODE = "true";
  } else {
    delete env.AI_SPEED_MODE;
  }

  return env;
}

export function runComputerUse(
  rawOptions: ComputerUseOptions,
  dependencies: RunComputerUseDependencies = {},
): ComputerUseExecutionResult {
  const options = normalizeComputerUseOptions(rawOptions);
  const cwd = dependencies.cwd ?? process.cwd();
  const scriptPath =
    dependencies.scriptPath ?? resolve(cwd, "scripts/computer-use/gemini-computer-use.py");
  const command = dependencies.pythonBin ?? "python3";
  const args = [scriptPath, options.task];

  if (!existsSync(scriptPath)) {
    return {
      status: "failed",
      reason: "script_not_found",
      exitCode: 1,
      command,
      args,
      scriptPath,
      stdoutTail: "",
      stderrTail: "",
      computerUseSafetyConfirmations: 0,
      error: `Script not found: ${scriptPath}`,
    };
  }

  const env = buildComputerUseEnv(dependencies.env ?? process.env, options);
  const spawn = dependencies.spawnSyncImpl ?? spawnSync;
  const result = spawn(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    input: "\n",
  });

  const stdoutTail = tail(result.stdout);
  const stderrTail = tail(result.stderr);
  const reasonCode = extractReasonCode(result.stderr, result.stdout);
  const safetySummary = extractSafetySummary(result.stdout, result.stderr);

  if (result.error) {
    return {
      status: "failed",
      reason: reasonCode ?? "process_spawn_error",
      exitCode: 1,
      command,
      args,
      scriptPath,
      stdoutTail,
      stderrTail,
      computerUseSafetyConfirmations: safetySummary.count,
      safetyConfirmationEvidence: { events: safetySummary.events },
      error: result.error.message,
    };
  }

  if ((result.status ?? 1) !== 0) {
    const code = result.status ?? 1;
    return {
      status: "failed",
      reason: reasonCode ?? `process_exit_${code}`,
      exitCode: code,
      command,
      args,
      scriptPath,
      stdoutTail,
      stderrTail,
      computerUseSafetyConfirmations: safetySummary.count,
      safetyConfirmationEvidence: { events: safetySummary.events },
      error: stderrTail || stdoutTail || "computer-use process failed without output",
    };
  }

  return {
    status: "ok",
    reason: "ok",
    exitCode: 0,
    command,
    args,
    scriptPath,
    stdoutTail,
    stderrTail,
    computerUseSafetyConfirmations: safetySummary.count,
    safetyConfirmationEvidence: { events: safetySummary.events },
  };
}
