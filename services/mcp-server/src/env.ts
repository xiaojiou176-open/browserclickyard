// @ts-nocheck
// 
import {
  NODE_ENV,
  readBoolEnv,
  readEnv,
  readIntEnv,
} from "../../../packages/core/src/config/env.js";

export const MCP_ENV = NODE_ENV;

export function mcpEnv(key: string, fallback = ""): string {
  return readEnv(MCP_ENV, key, fallback);
}

export function mcpBool(key: string, fallback = false): boolean {
  return readBoolEnv(MCP_ENV, key, fallback);
}

export function mcpInt(key: string, fallback: number): number {
  return readIntEnv(MCP_ENV, key, fallback);
}
