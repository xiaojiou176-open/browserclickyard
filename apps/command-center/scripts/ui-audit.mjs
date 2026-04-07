import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(scriptDir, "..", "..", ".runtime-cache");
const previewHost = "127.0.0.1";
const previewPortStart = 4173;
const backendHost = "127.0.0.1";
const defaultBackendPort = 17380;
let backendPort = String(defaultBackendPort);
let backendHealthUrl = `http://${backendHost}:${backendPort}/health/`;
const isCiLinux = process.platform === "linux" && process.env.CI === "true";

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(host, startPort, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await canListen(host, port)) {
      return port;
    }
  }
  throw new Error(`No available port found from ${startPort} to ${startPort + maxAttempts - 1}`);
}

function runCommand(cmd, args, options = {}) {
  if (process.platform === "win32") {
    throw new Error("ui-audit.mjs does not support Windows shell execution");
  }
  const executable = resolveTrustedExecutable(cmd);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function resolveTrustedExecutable(cmd) {
  if (cmd === "node") {
    return process.execPath;
  }
  if (cmd === "pnpm") {
    const npmExecPath = (process.env.npm_execpath ?? "").trim();
    if (npmExecPath && path.isAbsolute(npmExecPath) && /pnpm/i.test(path.basename(npmExecPath))) {
      return npmExecPath;
    }
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(locator, [cmd], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line);
    if (!output || !path.isAbsolute(output)) {
      throw new Error(`unable to resolve trusted executable for ${cmd}`);
    }
    return output;
  }
  throw new Error(`unsupported command for ui-audit: ${cmd}`);
}

async function runLighthouseWithRetry(targetUrl, reportPath, maxAttempts = 3) {
  const chromePath = await resolveChromePath();
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const chromeFlags = ["--headless"];
      if (isCiLinux) {
        chromeFlags.push("--no-sandbox", "--disable-dev-shm-usage");
      }
      await runCommand(
        "pnpm",
        [
          "exec",
          "lighthouse",
          targetUrl,
          `--chrome-flags=${chromeFlags.join(" ")}`,
          "--only-categories=performance,accessibility,best-practices,seo",
          "--output=json",
          `--output-path=${reportPath}`,
        ],
        {
          env: chromePath ? { ...process.env, CHROME_PATH: chromePath } : process.env,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      // Lighthouse on CI can intermittently fail to bootstrap Chrome.
      console.warn(`[ui-audit] lighthouse attempt ${attempt}/${maxAttempts} failed, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  throw lastError;
}

async function resolveChromePath() {
  if (process.env.CHROME_PATH) {
    try {
      await access(process.env.CHROME_PATH);
      return process.env.CHROME_PATH;
    } catch {
      // Fall through to discovery when CHROME_PATH points to a stale path.
    }
  }

  // Prefer Playwright's own browser resolution when available.
  try {
    const { chromium } = await import("playwright");
    const playwrightExecutable = chromium.executablePath();
    if (playwrightExecutable) {
      await access(playwrightExecutable);
      return playwrightExecutable;
    }
  } catch {
    // Continue with filesystem-based discovery.
  }

  const runnerHomeHints = [
    process.env.RUNNER_TEMP,
    process.env.GITHUB_WORKSPACE,
    process.env.RUNNER_WORKSPACE,
  ]
    .filter(Boolean)
    .flatMap((value) => {
      const resolved = path.resolve(value);
      return [
        path.resolve(resolved, ".."),
        path.resolve(resolved, "..", ".."),
      ];
    });

  const searchRoots = new Set([
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(process.env.HOME || "", ".cache", "ms-playwright"),
    path.join(process.cwd(), ".cache", "ms-playwright"),
    path.join(process.cwd(), "..", ".cache", "ms-playwright"),
    ...runnerHomeHints.map((homeHint) => path.join(homeHint, ".cache", "ms-playwright")),
  ]);
  if (process.env.GITHUB_WORKSPACE) {
    searchRoots.add(path.join(process.env.GITHUB_WORKSPACE, ".cache", "ms-playwright"));
    searchRoots.add(path.join(process.env.GITHUB_WORKSPACE, "..", ".cache", "ms-playwright"));
  }
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    searchRoots.add(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.env.RUNNER_TOOL_CACHE) {
    searchRoots.add(process.env.RUNNER_TOOL_CACHE);
    searchRoots.add(path.join(process.env.RUNNER_TOOL_CACHE, "..", ".cache", "ms-playwright"));
    searchRoots.add(
      path.join(process.env.RUNNER_TOOL_CACHE, "..", "..", ".cache", "ms-playwright"),
    );
    searchRoots.add(
      path.join(process.env.RUNNER_TOOL_CACHE, "..", "..", "..", ".cache", "ms-playwright"),
    );
  }

  for (const installRoot of searchRoots) {
    if (!installRoot) {
      continue;
    }
    let entries = [];
    try {
      entries = await readdir(installRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) {
        continue;
      }
      const chromeCandidate = path.join(installRoot, entry.name, "chrome-linux", "chrome");
      try {
        await access(chromeCandidate);
        return chromeCandidate;
      } catch {
        // Continue scanning other chromium installs.
      }
    }
  }

  // Fallback: try to find system Chrome/Chromium
  const systemPaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const chromePath of systemPaths) {
    try {
      await access(chromePath);
      return chromePath;
    } catch {
      // Continue searching.
    }
  }

  return null;
}

async function waitForServer(url, retries = 80, delayMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // Ignore and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Preview server is not reachable at ${url}`);
}

async function ensureBackendForAudit() {
  try {
    const runtimeBackendPortPath = path.resolve(runtimeDir, "dev", "backend.port");
    const savedPort = (await readFile(runtimeBackendPortPath, "utf-8")).trim();
    if (/^\d+$/.test(savedPort)) {
      backendPort = savedPort;
      backendHealthUrl = `http://${backendHost}:${backendPort}/health/`;
    }
  } catch {
    // Use default backend port when runtime metadata is absent.
  }
  try {
    const res = await fetch(backendHealthUrl);
    if (res.ok) {
      return null;
    }
    throw new Error(`backend health check failed: ${res.status}`);
  } catch {
    const nodeExecutable = resolveTrustedExecutable("node");
    const mockBackendProc = spawn(
      nodeExecutable,
      ["scripts/mock-backend.mjs"],
      {
        stdio: "inherit",
        shell: false,
        env: {
          ...process.env,
          BACKEND_PORT: backendPort,
        },
      },
    );
    await waitForServer(backendHealthUrl);
    return mockBackendProc;
  }
}

await mkdir(runtimeDir, { recursive: true });

const mockBackendProc = await ensureBackendForAudit();
const previewPort = await findAvailablePort(previewHost, previewPortStart);
const targetUrl = `http://${previewHost}:${previewPort}`;
const pnpmExecutable = resolveTrustedExecutable("pnpm");
const previewProc = spawn(
  pnpmExecutable,
  [
    "exec",
    "vite",
    "preview",
    "--host",
    previewHost,
    "--port",
    String(previewPort),
    "--strictPort",
  ],
  {
    stdio: "inherit",
    shell: false,
  },
);

try {
  await waitForServer(targetUrl);
  await runLighthouseWithRetry(targetUrl, `${runtimeDir}/lighthouse.report.json`);
  await runCommand("node", ["scripts/run-axe-audit.mjs", targetUrl]);
} finally {
  previewProc.kill("SIGTERM");
  if (mockBackendProc) {
    mockBackendProc.kill("SIGTERM");
  }
}
