import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const ctHost = process.env.UIQ_CT_HOST ?? "127.0.0.1";
const ctPort = Number(process.env.UIQ_CT_PORT ?? 4174);
const ctBaseUrl = `http://${ctHost}:${ctPort}`;
const defaultWorkers = process.env.CI ? "4" : "50%";
const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFilePath), "../../../../");
const ctReactPackagePath = require.resolve("@playwright/experimental-ct-react/package.json");
const ctReactDir = dirname(ctReactPackagePath);
const ctCoreDir = dirname(require.resolve("@playwright/experimental-ct-core"));
const { createPlugin } = require(resolve(ctCoreDir, "lib/vitePlugin.js"));

function resolveWorkers(): number | string {
  const raw = process.env.UIQ_PLAYWRIGHT_CT_WORKERS ?? defaultWorkers;
  if (/^\d+%$/.test(raw)) {
    return raw;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(
    `Invalid Playwright workers value '${raw}'. Use positive integer or percentage like '50%'.`,
  );
}

const config = {
  testDir: ".",
  outputDir: resolve(repoRoot, ".runtime-cache/test-results/apps-web-ct"),
  snapshotDir: "./__snapshots__",
  workers: resolveWorkers(),
  use: {
    baseURL: ctBaseUrl,
    ctPort,
    ctTemplateDir: "./template",
    ctViteConfig: {
      plugins: [react()],
      server: {
        host: ctHost,
        port: ctPort,
        strictPort: true,
      },
      preview: {
        host: ctHost,
        port: ctPort,
        strictPort: true,
      },
    },
  },
};

export default defineConfig(config, {
  "@playwright/test": {
    packageJSON: ctReactPackagePath,
    plugins: [() => createPlugin()],
    babelPlugins: [],
  },
  "@playwright/experimental-ct-core": {
    registerSourceFile: resolve(ctReactDir, "registerSource.mjs"),
    frameworkPluginFactory: () => import("@vitejs/plugin-react").then((plugin) => plugin.default()),
  },
});
