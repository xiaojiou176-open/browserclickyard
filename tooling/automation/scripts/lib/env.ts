import {
  NODE_ENV,
  readBoolEnv,
  readEnv,
  readIntEnv,
} from "../../../packages/core/src/config/env.js";

export const AUTOMATION_ENV = NODE_ENV;

export function automationEnv(key: string, fallback = ""): string {
  return readEnv(AUTOMATION_ENV, key, fallback);
}

export function automationBool(key: string, fallback = false): boolean {
  return readBoolEnv(AUTOMATION_ENV, key, fallback);
}

export function automationInt(key: string, fallback: number): number {
  return readIntEnv(AUTOMATION_ENV, key, fallback);
}
