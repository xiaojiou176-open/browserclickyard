import path from "node:path";
import { AUTOMATION_ENV } from "./lib/env.js";

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function postJson<T>(url: string, payload: unknown, token: string | null): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["x-automation-token"] = token;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${url} failed: ${response.status} ${detail}`);
  }
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const baseUrl = AUTOMATION_ENV.BASE_URL ?? "http://127.0.0.1:17380";
  const token = AUTOMATION_ENV.AUTOMATION_API_TOKEN ?? null;
  const sessionDir =
    getArg("sessionDir") ??
    path.resolve(process.cwd(), "..", ".runtime-cache", "automation", "session-fallback");
  const mode = (getArg("mode") ?? "gemini") as "gemini" | "ensemble";

  const previewPayload = {
    artifacts: { session_dir: sessionDir },
    video_analysis_mode: mode,
    extractor_strategy: "balanced",
    auto_refine_iterations: 3,
  };

  const preview = await postJson<{ preview_id: string }>(
    `${baseUrl}/api/reconstruction/preview`,
    previewPayload,
    token,
  );
  const generated = await postJson<{ flow_id: string; template_id: string; run_id: string | null }>(
    `${baseUrl}/api/reconstruction/generate`,
    {
      preview_id: preview.preview_id,
      template_name: "reconstructed-template",
      create_run: false,
      run_params: {},
    },
    token,
  );

  process.stdout.write(
    `${JSON.stringify({ preview_id: preview.preview_id, ...generated }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`reconstruct-and-replay failed: ${message}\n`);
  process.exitCode = 1;
});
