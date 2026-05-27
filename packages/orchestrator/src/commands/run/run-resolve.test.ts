import assert from "node:assert/strict";
import test from "node:test";
import { resolveComputerUseConfig } from "./run-resolve.js";
import type { ProfileConfig, TargetConfig } from "./run-types.js";

function withEnv<T>(overrides: Record<string, string | undefined>, task: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return task();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function baseProfile(): ProfileConfig {
  return {
    name: "pr",
    steps: ["computer_use"],
    gates: {
      consoleErrorMax: 0,
      pageErrorMax: 0,
      http5xxMax: 0,
    },
  };
}

function baseTarget(): TargetConfig {
  return {
    name: "web.ci",
    type: "web",
    driver: "web-playwright",
    baseUrl: "http://127.0.0.1:4173",
    scope: {
      domains: ["http://127.0.0.1:4173"],
    },
  };
}

test("resolveComputerUseConfig uses task priority profile > target > UIQ_COMPUTER_USE_TASK", () => {
  withEnv({ UIQ_COMPUTER_USE_TASK: "env task" }, () => {
    const resolved = resolveComputerUseConfig(
      {
        ...baseTarget(),
        computerUse: { task: "target task", maxSteps: 20, speedMode: false },
      },
      {
        ...baseProfile(),
        computerUse: { task: "profile task", maxSteps: 30, speedMode: true },
      },
    );
    assert.equal(resolved.task, "profile task");
    assert.equal(resolved.taskSource, "profile");
    assert.equal(resolved.maxSteps, 30);
    assert.equal(resolved.speedMode, true);
  });
});

test("resolveComputerUseConfig falls back to target task then env task", () => {
  withEnv({ UIQ_COMPUTER_USE_TASK: "env task" }, () => {
    const fromTarget = resolveComputerUseConfig(
      {
        ...baseTarget(),
        computerUse: { task: "target task" },
      },
      baseProfile(),
    );
    assert.equal(fromTarget.task, "target task");
    assert.equal(fromTarget.taskSource, "target");

    const fromEnv = resolveComputerUseConfig(baseTarget(), baseProfile());
    assert.equal(fromEnv.task, "env task");
    assert.equal(fromEnv.taskSource, "env");
  });
});
