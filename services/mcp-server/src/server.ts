// @ts-nocheck
// 
import { startMcpServer } from "./core.js";

async function main(): Promise<void> {
  await startMcpServer();
  process.stdin.resume();
  await new Promise(() => {
    // Keep stdio MCP process alive after transport is connected.
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[mcp-server] startup failed: ${message}\n`);
  process.exit(1);
});
