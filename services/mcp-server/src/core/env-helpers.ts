export type NodeEnv = Record<string, string | undefined>;

export const NODE_ENV: NodeEnv = process.env;

export function readEnv(env: NodeEnv, key: string, fallback = ""): string {
  const value = env[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

export function readBoolEnv(env: NodeEnv, key: string, fallback = false): boolean {
  const raw = readEnv(env, key, fallback ? "1" : "0")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function readIntEnv(env: NodeEnv, key: string, fallback: number): number {
  const raw = Number.parseInt(readEnv(env, key, String(fallback)).trim(), 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}
