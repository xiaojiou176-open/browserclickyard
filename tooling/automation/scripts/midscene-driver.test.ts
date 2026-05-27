import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { runMidsceneTakeover } from "./midscene-driver.js";

const ENV_KEYS = [
  "MIDSCENE_STRICT",
  "MIDSCENE_ALLOW_FALLBACK",
  "MIDSCENE_MODEL_NAME",
  "GEMINI_API_KEY",
] as const;

type EnvPatch = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

type RecordedAction =
  | ["goto", string]
  | ["fillEmail", string]
  | ["fillPassword", string]
  | ["clickCreate"]
  | ["waitForSelector", string];

const TEST_PASSWORD_PLACEHOLDER = "__REDACTED_TEST_PASSWORD__";

function withEnv(patch: EnvPatch, run: () => Promise<void>): Promise<void> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    const nextValue = patch[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  return run().finally(() => {
    for (const key of ENV_KEYS) {
      const previous = snapshot.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
}

test("strict mode requires MIDSCENE_MODEL_NAME or GEMINI_API_KEY", async () => {
  await withEnv(
    {
      MIDSCENE_STRICT: "true",
      MIDSCENE_ALLOW_FALLBACK: "false",
      MIDSCENE_MODEL_NAME: undefined,
      GEMINI_API_KEY: undefined,
    },
    async () => {
      const page = {} as Page;
      await assert.rejects(
        () =>
          runMidsceneTakeover({
            page,
            startUrl: "https://example.com",
            suggestedEmail: "tester@example.com",
            suggestedPassword: TEST_PASSWORD_PLACEHOLDER,
            successSelector: "",
          }),
        /(MIDSCENE_MODEL_NAME or GEMINI_API_KEY|GEMINI_API_KEY is required)/,
      );
    },
  );
});

test("fallback path runs deterministic playwright actions when config is missing and fallback is allowed", async () => {
  await withEnv(
    {
      MIDSCENE_STRICT: "false",
      MIDSCENE_ALLOW_FALLBACK: "true",
      MIDSCENE_MODEL_NAME: undefined,
      GEMINI_API_KEY: undefined,
    },
    async () => {
      const actions: RecordedAction[] = [];
      const page = {
        goto: async (url: string) => {
          actions.push(["goto", url]);
        },
        getByLabel: (label: string) => ({
          fill: async (value: string) => {
            if (label === "Email") {
              actions.push(["fillEmail", value]);
            }
            if (label === "Password") {
              actions.push(["fillPassword", value]);
            }
          },
        }),
        getByRole: (_role: string, options: { name: string }) => ({
          click: async () => {
            if (options.name === "Create Account") {
              actions.push(["clickCreate"]);
            }
          },
        }),
        waitForSelector: async (selector: string) => {
          actions.push(["waitForSelector", selector]);
        },
      } as unknown as Page;

      await runMidsceneTakeover({
        page,
        startUrl: "https://example.com/signup",
        suggestedEmail: "fallback@example.com",
        suggestedPassword: TEST_PASSWORD_PLACEHOLDER,
        successSelector: "#signup-success",
      });

      assert.deepEqual(actions, [
        ["goto", "https://example.com/signup"],
        ["fillEmail", "fallback@example.com"],
        ["fillPassword", TEST_PASSWORD_PLACEHOLDER],
        ["clickCreate"],
        ["waitForSelector", "#signup-success"],
      ]);
    },
  );
});
