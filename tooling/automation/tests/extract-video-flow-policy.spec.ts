import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  buildAiInputPack,
  type CapturedEvent,
  createContextCacheKey,
  writeContextCache,
} from "../scripts/lib/ai-input-pack.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function withEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

test("strict provider policy hard-fails when gemini is unavailable and blocks event-log fallback", async () => {
  const sessionDir = mkdtempSync(path.resolve(tmpdir(), "uiq-extract-video-policy-"));
  try {
    mkdirSync(path.join(sessionDir, ".context-cache", "video-flow"), { recursive: true });
    writeFileSync(
      path.join(sessionDir, "session.transcript.json"),
      JSON.stringify([], null, 2),
      "utf-8",
    );
    writeFileSync(
      path.join(sessionDir, "event-log.json"),
      JSON.stringify(
        [
          {
            ts: new Date().toISOString(),
            type: "navigate",
            url: "https://example.com/register",
            target: {
              tag: "a",
              id: null,
              name: null,
              type: null,
              role: null,
              text: null,
              cssPath: 'a[href="/register"]',
            },
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      path.join(sessionDir, "register.har"),
      JSON.stringify({ log: { entries: [] } }, null, 2),
      "utf-8",
    );
    writeFileSync(
      path.join(sessionDir, "final.register.html"),
      "<html><body>register</body></html>",
      "utf-8",
    );

    const run = spawnSync(
      "pnpm",
      [
        "--dir",
        "automation",
        "exec",
        "tsx",
        "scripts/extract-video-flow.ts",
        `--sessionDir=${sessionDir}`,
      ],
      {
        cwd: path.resolve(__dirname, "..", ".."),
        encoding: "utf-8",
        env: withEnv({
          GEMINI_API_KEY: undefined,
        }),
      },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ai.gemini.strict_policy_violation");
    expect(run.stderr).toContain("extract-video-flow failed");
    expect(existsSync(path.join(sessionDir, "video_flow.signals.json"))).toBe(false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("strict provider policy hard-fails when cached analysis has no candidate steps and would fallback to event-log", async () => {
  const sessionDir = mkdtempSync(path.resolve(tmpdir(), "uiq-extract-video-policy-cache-"));
  try {
    const events: CapturedEvent[] = [
      {
        ts: new Date().toISOString(),
        type: "click",
        url: "https://example.com/register",
        target: {
          tag: "button",
          id: null,
          name: null,
          type: null,
          role: "button",
          text: "Continue",
          cssPath: 'button[type="submit"]',
        },
      },
    ];
    const transcript = [] as Array<{ t: string; text: string }>;
    const har = { log: { entries: [] } };
    const html = "<html><body>register</body></html>";
    const videoPath = path.join(sessionDir, "session.mp4");
    const inputPack = buildAiInputPack({
      videoPath,
      transcript,
      events,
      har,
      htmlContent: html,
    });
    const cacheDir = path.join(sessionDir, ".context-cache", "video-flow");
    mkdirSync(cacheDir, { recursive: true });
    const cacheKey = createContextCacheKey({
      namespace: "video-flow.gemini.analysis.v1",
      provider: "gemini",
      model: "models/gemini-3.1-pro-preview",
      input: inputPack.payload,
      extras: { thinkingLevel: "high" },
    });
    await writeContextCache(cacheDir, cacheKey, {
      detectedSignals: ["cached"],
      candidateSteps: [],
      modelName: "models/gemini-3.1-pro-preview",
    });
    writeFileSync(
      path.join(sessionDir, "session.transcript.json"),
      JSON.stringify(transcript, null, 2),
      "utf-8",
    );
    writeFileSync(
      path.join(sessionDir, "event-log.json"),
      JSON.stringify(events, null, 2),
      "utf-8",
    );
    writeFileSync(path.join(sessionDir, "register.har"), JSON.stringify(har, null, 2), "utf-8");
    writeFileSync(path.join(sessionDir, "final.register.html"), html, "utf-8");

    const run = spawnSync(
      "pnpm",
      [
        "--dir",
        "automation",
        "exec",
        "tsx",
        "scripts/extract-video-flow.ts",
        `--sessionDir=${sessionDir}`,
      ],
      {
        cwd: path.resolve(__dirname, "..", ".."),
        encoding: "utf-8",
        env: withEnv({
          AI_SPEED_MODE: undefined,
          GEMINI_API_KEY: undefined,
        }),
      },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ai.gemini.strict_policy_violation");
    expect(run.stderr).toContain("extract-video-flow failed");
    expect(existsSync(path.join(sessionDir, "video_flow.signals.json"))).toBe(false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
