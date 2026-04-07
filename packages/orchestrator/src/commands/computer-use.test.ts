import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildComputerUseEnv,
  type NormalizedComputerUseOptions,
  runComputerUse,
} from "./computer-use.js";

function createScriptFixture(): { dir: string; scriptPath: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "uiq-computer-use-"));
  const scriptPath = resolve(dir, "gemini-computer-use.py");
  writeFileSync(scriptPath, "#!/usr/bin/env python3\nprint('ok')\n", "utf8");
  return { dir, scriptPath };
}

test("buildComputerUseEnv sets AI_SPEED_MODE only when speedMode=true", () => {
  const options: NormalizedComputerUseOptions = {
    task: "capture current screen",
    maxSteps: 42,
    speedMode: false,
    runId: "run-a",
  };
  const disabled = buildComputerUseEnv({ PATH: "/bin", AI_SPEED_MODE: "true" }, options);
  assert.equal(disabled.AI_MAX_STEPS, "42");
  assert.equal(disabled.AI_RUN_ID, "run-a");
  assert.equal(disabled.AI_SPEED_MODE, undefined);

  const enabled = buildComputerUseEnv({ PATH: "/bin" }, { ...options, speedMode: true });
  assert.equal(enabled.AI_SPEED_MODE, "true");
});

test("runComputerUse dispatches python script with expected args/env", () => {
  const fixture = createScriptFixture();
  try {
    let observedCommand = "";
    let observedArgs: readonly string[] = [];
    let observedEnv: NodeJS.ProcessEnv = {};

    const result = runComputerUse(
      {
        task: "open browser and login",
        maxSteps: 12,
        speedMode: true,
        runId: "run-1",
      },
      {
        cwd: fixture.dir,
        scriptPath: fixture.scriptPath,
        env: { PATH: "/bin" },
        spawnSyncImpl(command, args, options) {
          observedCommand = command;
          observedArgs = args;
          observedEnv = options.env;
          return {
            pid: 1,
            output: [null, "ok", ""],
            stdout: "ok",
            stderr: "",
            status: 0,
            signal: null,
          };
        },
      },
    );

    assert.equal(observedCommand, "python3");
    assert.deepEqual(observedArgs, [fixture.scriptPath, "open browser and login"]);
    assert.equal(observedEnv.AI_MAX_STEPS, "12");
    assert.equal(observedEnv.AI_RUN_ID, "run-1");
    assert.equal(observedEnv.AI_SPEED_MODE, "true");
    assert.equal(result.status, "ok");
    assert.equal(result.reason, "ok");
    assert.equal(result.computerUseSafetyConfirmations, 0);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("runComputerUse returns reason/error when child process exits non-zero", () => {
  const fixture = createScriptFixture();
  try {
    const result = runComputerUse(
      {
        task: "open browser and login",
        maxSteps: 10,
        speedMode: false,
      },
      {
        cwd: fixture.dir,
        scriptPath: fixture.scriptPath,
        env: { PATH: "/bin" },
        spawnSyncImpl() {
          return {
            pid: 1,
            output: [null, "", "fatal error"],
            stdout: "",
            stderr: "fatal error",
            status: 3,
            signal: null,
          };
        },
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "process_exit_3");
    assert.equal(result.exitCode, 3);
    assert.equal(result.computerUseSafetyConfirmations, 0);
    assert.match(result.error ?? "", /fatal error/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("runComputerUse uses structured reason code and safety confirmation evidence from child output", () => {
  const fixture = createScriptFixture();
  try {
    const result = runComputerUse(
      {
        task: "confirm checkout",
        maxSteps: 2,
      },
      {
        cwd: fixture.dir,
        scriptPath: fixture.scriptPath,
        env: { PATH: "/bin" },
        spawnSyncImpl() {
          return {
            pid: 1,
            output: [
              null,
              [
                'COMPUTER_USE_SAFETY_SUMMARY={"computerUseSafetyConfirmations":1,"events":[{"action":"submit","gateDecision":"blocked"}]}',
                "COMPUTER_USE_REASON_CODE=ai.gemini.computer_use.max_steps_exceeded",
              ].join("\n"),
              "",
            ],
            stdout: [
              'COMPUTER_USE_SAFETY_SUMMARY={"computerUseSafetyConfirmations":1,"events":[{"action":"submit","gateDecision":"blocked"}]}',
              "COMPUTER_USE_REASON_CODE=ai.gemini.computer_use.max_steps_exceeded",
            ].join("\n"),
            stderr: "",
            status: 2,
            signal: null,
          };
        },
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "ai.gemini.computer_use.max_steps_exceeded");
    assert.equal(result.computerUseSafetyConfirmations, 1);
    assert.equal(result.safetyConfirmationEvidence?.events.length, 1);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
