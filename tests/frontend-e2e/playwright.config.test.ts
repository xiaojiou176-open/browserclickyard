import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const configModuleUrl = new URL("./playwright.config.ts", import.meta.url).href;
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const cachePath = path.resolve(thisDir, "../../.runtime-cache/cache/frontend-e2e.port.json");
const viteConfigCommandPattern = new RegExp(
  String.raw`scripts/lib/node-bin\.sh" vite --con` + "fig",
);

async function loadConfigWithPort(
  port: string | undefined,
  backendPort?: string,
  clearPortCache = true,
  defaultPort?: string,
  grep?: string,
  grepInvert?: string,
) {
  const previous = process.env.UIQ_FRONTEND_E2E_PORT;
  const previousBackendPort = process.env.BACKEND_PORT;
  const previousDefaultPort = process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT;
  const previousGrep = process.env.UIQ_FRONTEND_E2E_GREP;
  const previousGrepInvert = process.env.UIQ_FRONTEND_E2E_GREP_INVERT;
  const previousViteBaseUrl = process.env.VITE_DEFAULT_BASE_URL;
  const previousViteApiBaseUrl = process.env.VITE_API_BASE_URL;
  const previousUiqAutomationToken = process.env.UIQ_AUTOMATION_TOKEN;
  const previousAutomationApiToken = process.env.AUTOMATION_API_TOKEN;
  const previousViteAutomationToken = process.env.VITE_AUTOMATION_TOKEN;
  const hadCache = existsSync(cachePath);
  const cacheSnapshot = hadCache ? readFileSync(cachePath, "utf8") : undefined;
  if (clearPortCache && existsSync(cachePath)) {
    rmSync(cachePath, { force: true });
  }
  if (port === undefined) {
    delete process.env.UIQ_FRONTEND_E2E_PORT;
  } else {
    process.env.UIQ_FRONTEND_E2E_PORT = port;
  }
  if (backendPort === undefined) {
    delete process.env.BACKEND_PORT;
  } else {
    process.env.BACKEND_PORT = backendPort;
  }
  if (defaultPort === undefined) {
    delete process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT;
  } else {
    process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT = defaultPort;
  }
  if (grep === undefined) {
    delete process.env.UIQ_FRONTEND_E2E_GREP;
  } else {
    process.env.UIQ_FRONTEND_E2E_GREP = grep;
  }
  if (grepInvert === undefined) {
    delete process.env.UIQ_FRONTEND_E2E_GREP_INVERT;
  } else {
    process.env.UIQ_FRONTEND_E2E_GREP_INVERT = grepInvert;
  }

  try {
    const cacheBuster = `${Date.now()}-${randomUUID()}`;
    const mod = await import(`${configModuleUrl}?v=${cacheBuster}`);
    return mod.default;
  } finally {
    if (previous === undefined) {
      delete process.env.UIQ_FRONTEND_E2E_PORT;
    } else {
      process.env.UIQ_FRONTEND_E2E_PORT = previous;
    }
    if (previousBackendPort === undefined) {
      delete process.env.BACKEND_PORT;
    } else {
      process.env.BACKEND_PORT = previousBackendPort;
    }
    if (previousDefaultPort === undefined) {
      delete process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT;
    } else {
      process.env.UIQ_FRONTEND_E2E_DEFAULT_PORT = previousDefaultPort;
    }
    if (previousGrep === undefined) {
      delete process.env.UIQ_FRONTEND_E2E_GREP;
    } else {
      process.env.UIQ_FRONTEND_E2E_GREP = previousGrep;
    }
    if (previousGrepInvert === undefined) {
      delete process.env.UIQ_FRONTEND_E2E_GREP_INVERT;
    } else {
      process.env.UIQ_FRONTEND_E2E_GREP_INVERT = previousGrepInvert;
    }
    if (previousViteBaseUrl === undefined) {
      delete process.env.VITE_DEFAULT_BASE_URL;
    } else {
      process.env.VITE_DEFAULT_BASE_URL = previousViteBaseUrl;
    }
    if (previousViteApiBaseUrl === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previousViteApiBaseUrl;
    }
    if (previousUiqAutomationToken === undefined) {
      delete process.env.UIQ_AUTOMATION_TOKEN;
    } else {
      process.env.UIQ_AUTOMATION_TOKEN = previousUiqAutomationToken;
    }
    if (previousAutomationApiToken === undefined) {
      delete process.env.AUTOMATION_API_TOKEN;
    } else {
      process.env.AUTOMATION_API_TOKEN = previousAutomationApiToken;
    }
    if (previousViteAutomationToken === undefined) {
      delete process.env.VITE_AUTOMATION_TOKEN;
    } else {
      process.env.VITE_AUTOMATION_TOKEN = previousViteAutomationToken;
    }
    if (clearPortCache) {
      if (hadCache && cacheSnapshot !== undefined) {
        writeFileSync(cachePath, cacheSnapshot, "utf8");
      } else {
        rmSync(cachePath, { force: true });
      }
    }
  }
}

test("playwright config picks an available default port when UIQ_FRONTEND_E2E_PORT is not provided", async () => {
  const config = await loadConfigWithPort(undefined);
  const baseURL = config.use?.baseURL;
  const webServerURL = config.webServer?.url;
  assert.equal(config.testMatch, "**/*.spec.ts");
  assert.match(String(baseURL), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(baseURL, webServerURL);
  const selectedPort = Number.parseInt(String(baseURL).split(":").pop() ?? "", 10);
  const expectedBase = 43000 + Math.abs(process.pid % 5000);
  assert.ok(Number.isInteger(selectedPort));
  assert.ok(selectedPort >= expectedBase);
});

test("playwright config allows UIQ_FRONTEND_E2E_PORT override", async () => {
  const config = await loadConfigWithPort("50001");
  const baseURL = config.use?.baseURL;
  const webServerURL = config.webServer?.url;

  assert.equal(baseURL, "http://127.0.0.1:50001");
  assert.equal(webServerURL, "http://127.0.0.1:50001");
  assert.equal(config.timeout, 150_000);
  assert.equal(config.webServer?.reuseExistingServer, false);
});

test("playwright config falls back when candidate default port is already occupied", async () => {
  const lockServer = createServer();
  await new Promise<void>((resolve, reject) => {
    lockServer.once("error", reject);
    lockServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = lockServer.address();
  assert.ok(address && typeof address !== "string");
  const candidatePort = address.port;

  try {
    const config = await loadConfigWithPort(undefined, undefined, true, String(candidatePort));
    const baseURL = String(config.use?.baseURL);
    const selectedPort = Number.parseInt(baseURL.split(":").pop() ?? "", 10);
    assert.notEqual(selectedPort, candidatePort);
    assert.ok(Number.isInteger(selectedPort) && selectedPort > candidatePort);
  } finally {
    await new Promise<void>((resolve) => lockServer.close(() => resolve()));
  }
});

test("playwright config allows explicit backend port override", async () => {
  const config = await loadConfigWithPort(undefined, "39001");
  const webServerEnv = config.webServer?.env ?? {};

  assert.equal(webServerEnv.BACKEND_PORT, "39001");
  assert.equal(webServerEnv.VITE_DEFAULT_BASE_URL, "http://127.0.0.1:39001");
});

test("playwright config disables mock backend when nonstub grep is selected", async () => {
  const config = await loadConfigWithPort(
    undefined,
    undefined,
    true,
    undefined,
    "@frontend-nonstub|@nonstub",
  );
  const command = String(config.webServer?.command ?? "");
  assert.doesNotMatch(command, /mock-backend\.mjs/);
  assert.match(command, /uvicorn/);
  assert.match(command, /alembic -c alembic\.ini upgrade head/);
  assert.match(command, viteConfigCommandPattern);
  assert.equal(config.workers, 1);
});

test("playwright config keeps mock backend for non-nonstub runs", async () => {
  const config = await loadConfigWithPort(
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    "@frontend-nonstub|@nonstub",
  );
  const command = String(config.webServer?.command ?? "");
  assert.match(command, /mock-backend\.mjs/);
  assert.match(command, /trap cleanup EXIT INT TERM/);
  assert.match(command, /backend_pid="\$!"/);
  assert.match(command, viteConfigCommandPattern);
});

test("playwright config excludes nonstub tags by default when mock backend is enabled", async () => {
  const config = await loadConfigWithPort(undefined);
  const invert = config.grepInvert;
  assert.ok(invert instanceof RegExp);
  assert.equal(invert.test("@frontend-nonstub"), true);
  assert.equal(invert.test("@nonstub"), true);
  const command = String(config.webServer?.command ?? "");
  assert.match(command, /mock-backend\.mjs/);
});

test("playwright config resolves a backend port for nonstub runs", async () => {
  const config = await loadConfigWithPort(
    undefined,
    undefined,
    true,
    undefined,
    "@frontend-nonstub|@nonstub",
  );
  const webServerEnv = config.webServer?.env ?? {};
  const backendPort = Number.parseInt(String(webServerEnv.BACKEND_PORT ?? ""), 10);
  const expectedBase = 28000 + Math.abs(process.pid % 10000);
  assert.ok(Number.isInteger(backendPort) && backendPort >= expectedBase);
  assert.equal(webServerEnv.VITE_DEFAULT_BASE_URL, `http://127.0.0.1:${backendPort}`);
  assert.equal(webServerEnv.VITE_API_BASE_URL, "");
  assert.ok(
    typeof webServerEnv.AUTOMATION_API_TOKEN === "string" &&
      webServerEnv.AUTOMATION_API_TOKEN.length >= 12,
  );
  assert.equal(webServerEnv.VITE_AUTOMATION_TOKEN, webServerEnv.AUTOMATION_API_TOKEN);
});

test("playwright config clears inherited VITE_API_BASE_URL for frontend webServer", async () => {
  const previous = process.env.VITE_API_BASE_URL;
  process.env.VITE_API_BASE_URL = "http://127.0.0.1:39099";
  try {
    const config = await loadConfigWithPort(
      undefined,
      undefined,
      true,
      undefined,
      "@frontend-nonstub|@nonstub",
    );
    const webServerEnv = config.webServer?.env ?? {};

    assert.equal(webServerEnv.VITE_API_BASE_URL, "");
  } finally {
    if (previous === undefined) {
      delete process.env.VITE_API_BASE_URL;
    } else {
      process.env.VITE_API_BASE_URL = previous;
    }
  }
});

test("playwright config allows nonstub backend port override via env", async () => {
  const previous = process.env.UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT;
  process.env.UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT = "39002";
  try {
    const config = await loadConfigWithPort(
      undefined,
      undefined,
      true,
      undefined,
      "@frontend-nonstub|@nonstub",
    );
    const webServerEnv = config.webServer?.env ?? {};

    assert.equal(webServerEnv.BACKEND_PORT, "39002");
    assert.equal(webServerEnv.VITE_DEFAULT_BASE_URL, "http://127.0.0.1:39002");
  } finally {
    if (previous === undefined) {
      delete process.env.UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT;
    } else {
      process.env.UIQ_FRONTEND_E2E_NONSTUB_BACKEND_PORT = previous;
    }
  }
});

test("playwright config injects the same nonstub token into backend and frontend env", async () => {
  const config = await loadConfigWithPort(
    undefined,
    undefined,
    true,
    undefined,
    "@frontend-nonstub|@nonstub",
  );
  const webServerEnv = config.webServer?.env ?? {};
  const token = String(webServerEnv.UIQ_AUTOMATION_TOKEN ?? "");
  assert.ok(token.length >= 16);
  assert.equal(webServerEnv.AUTOMATION_API_TOKEN, token);
  assert.equal(webServerEnv.VITE_AUTOMATION_TOKEN, token);
});
