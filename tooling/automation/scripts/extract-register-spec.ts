import { spawn } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve(process.cwd(), "scripts", "extract-flow-spec.ts");
const args = ["tsx", scriptPath, ...process.argv.slice(2)];

const child = spawn("pnpm", args, {
  cwd: process.cwd(),
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
