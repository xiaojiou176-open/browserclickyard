import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const configModuleUrl = new URL("./playwright.config.ts", import.meta.url).href;
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "../../../../");
const viteConfigPath = path.resolve(repoRoot, "tests/web-harness/vite.config.ts");

type EnvPatch = Record<string, string | undefined>;

async function loadWebPlaywrightConfig(patch: EnvPatch = {}) {
  const keys = Object.keys(patch);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const next = patch[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    const cacheBuster = `${Date.now()}-${randomUUID()}`;
    const mod = await import(`${configModuleUrl}?v=${cacheBuster}`);
    return mod.default;
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("web e2e config defaults to 0 retries locally and pins webServer cwd to repo root", async () => {
  const config = await loadWebPlaywrightConfig({
    CI: undefined,
    UIQ_WEB_E2E_RETRIES: undefined,
  });

  assert.equal(config.retries, 0);
  assert.equal(config.webServer?.cwd, repoRoot);
  assert.equal(config.webServer?.reuseExistingServer, true);
  assert.ok(
    String(config.webServer?.command).includes(`--config ${JSON.stringify(viteConfigPath)}`),
  );
  assert.match(String(config.use?.baseURL), /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("web e2e config defaults to 1 retry in CI and allows explicit 0-2 override", async () => {
  const ciDefault = await loadWebPlaywrightConfig({
    CI: "true",
    UIQ_WEB_E2E_RETRIES: undefined,
  });
  assert.equal(ciDefault.retries, 1);
  assert.equal(ciDefault.webServer?.reuseExistingServer, false);

  const explicitOverride = await loadWebPlaywrightConfig({
    CI: "true",
    UIQ_WEB_E2E_RETRIES: "2",
  });
  assert.equal(explicitOverride.retries, 2);
});

test("web e2e config rejects invalid retry values", async () => {
  await assert.rejects(
    loadWebPlaywrightConfig({ UIQ_WEB_E2E_RETRIES: "3" }),
    /Invalid UIQ_WEB_E2E_RETRIES/,
  );
});

test("web e2e config falls back when default web port is already occupied", async () => {
  const lockServer = createServer();
  await new Promise<void>((resolve, reject) => {
    lockServer.once("error", reject);
    lockServer.listen(4173, "127.0.0.1", () => resolve());
  });

  try {
    const config = await loadWebPlaywrightConfig({
      UIQ_WEB_PORT: undefined,
      BASE_URL: undefined,
      UIQ_BASE_URL: undefined,
    });
    const baseURL = String(config.use?.baseURL);
    assert.notEqual(baseURL, "http://127.0.0.1:4173");
    assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await new Promise<void>((resolve) => lockServer.close(() => resolve()));
  }
});

test("web e2e config prefers dedicated apps-web port override", async () => {
  const config = await loadWebPlaywrightConfig({
    UIQ_WEB_APP_E2E_PORT: "44199",
    UIQ_WEB_PORT: "4173",
    BASE_URL: undefined,
    UIQ_BASE_URL: undefined,
  });

  assert.equal(String(config.use?.baseURL), "http://127.0.0.1:44199");
  assert.match(String(config.webServer?.command), /--port 44199 --strictPort/);
});
