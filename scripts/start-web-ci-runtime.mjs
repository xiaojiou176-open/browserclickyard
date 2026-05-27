import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT = 44173;

function resolvePort(raw) {
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid UIQ_WEB_PORT '${raw}': expected integer in range 1-65535`);
  }
  return parsed;
}

const port = resolvePort(process.env.UIQ_WEB_PORT);
const buildArgs = ["--dir", "apps/command-center", "build"];
const buildResult = spawnSync("pnpm", buildArgs, {
  stdio: "inherit",
  env: { ...process.env, UIQ_WEB_PORT: String(port) },
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const args = [
  "--dir",
  "apps/command-center",
  "preview",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
];
const child = spawn("pnpm", args, {
  stdio: "inherit",
  env: { ...process.env, UIQ_WEB_PORT: String(port) },
});

const forwardSignal = (signal) => {
  if (child.exitCode === null) {
    try {
      child.kill(signal);
    } catch {
      // Best-effort forwarding only.
    }
  }
};

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
