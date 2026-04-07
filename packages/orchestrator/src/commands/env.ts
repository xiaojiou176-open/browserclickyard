import { NODE_ENV, readBoolEnv, readEnv, readIntEnv } from "../../../core/src/config/env.js";

export const ORCHESTRATOR_ENV = NODE_ENV;

export function orchestratorEnv(key: string, fallback = ""): string {
  return readEnv(ORCHESTRATOR_ENV, key, fallback);
}

export function orchestratorBool(key: string, fallback = false): boolean {
  return readBoolEnv(ORCHESTRATOR_ENV, key, fallback);
}

export function orchestratorInt(key: string, fallback: number): number {
  return readIntEnv(ORCHESTRATOR_ENV, key, fallback);
}
