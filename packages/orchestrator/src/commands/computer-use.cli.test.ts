import assert from "node:assert/strict";
import test from "node:test";
import { dispatchComputerUseCommand, parseArgs } from "../cli.js";

test("parseArgs parses computer-use options", () => {
  const args = parseArgs([
    "computer-use",
    "--task",
    "open browser and login",
    "--max-steps",
    "88",
    "--speed-mode",
    "true",
    "--run-id",
    "run-xyz",
  ]);

  assert.equal(args.command, "computer-use");
  assert.equal(args.task, "open browser and login");
  assert.equal(args.maxSteps, 88);
  assert.equal(args.speedMode, true);
  assert.equal(args.runId, "run-xyz");
});

test("dispatchComputerUseCommand defaults speedMode=false and maxSteps=50", () => {
  const args = parseArgs(["computer-use", "--task", "check current page"]);
  const logs: string[] = [];
  const errors: string[] = [];
  let captured: Record<string, unknown> | undefined;

  const exitCode = dispatchComputerUseCommand(args, "run-default", {
    execute(options) {
      captured = options as Record<string, unknown>;
      return {
        status: "ok",
        reason: "ok",
        exitCode: 0,
        command: "python3",
        args: ["scripts/computer-use/gemini-computer-use.py", "check current page"],
        scriptPath: "scripts/computer-use/gemini-computer-use.py",
        stdoutTail: "",
        stderrTail: "",
        computerUseSafetyConfirmations: 0,
        safetyConfirmationEvidence: { events: [] },
      };
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(captured, {
    task: "check current page",
    maxSteps: 50,
    speedMode: false,
    runId: "run-default",
  });
  assert.equal(errors.length, 0);
  assert.equal(
    logs.some((line) => line.startsWith("computerUse=")),
    true,
  );
});

test("dispatchComputerUseCommand emits reason/error on failure", () => {
  const args = parseArgs([
    "computer-use",
    "--task",
    "check current page",
    "--max-steps",
    "5",
    "--speed-mode",
    "true",
  ]);
  const errors: string[] = [];

  const exitCode = dispatchComputerUseCommand(args, "run-fail", {
    execute() {
      return {
        status: "failed",
        reason: "process_exit_7",
        exitCode: 7,
        command: "python3",
        args: ["scripts/computer-use/gemini-computer-use.py", "check current page"],
        scriptPath: "scripts/computer-use/gemini-computer-use.py",
        stdoutTail: "",
        stderrTail: "fatal error",
        computerUseSafetyConfirmations: 0,
        safetyConfirmationEvidence: { events: [] },
        error: "fatal error",
      };
    },
    log: () => undefined,
    error: (message) => errors.push(message),
  });

  assert.equal(exitCode, 7);
  assert.equal(
    errors.some((line) => line.includes("computer_use_reason=process_exit_7")),
    true,
  );
  assert.equal(
    errors.some((line) => line.includes("computer_use_error=fatal error")),
    true,
  );
});
