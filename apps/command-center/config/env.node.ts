export type FrontendNodeEnv = Record<string, string | undefined>;

export const FRONTEND_NODE_ENV: FrontendNodeEnv = process.env;

export function frontendNodeEnv(key: string, fallback = ""): string {
  const value = FRONTEND_NODE_ENV[key];
  return value === undefined ? fallback : value;
}
