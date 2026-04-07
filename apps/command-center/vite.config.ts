import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { frontendNodeEnv } from "./config/env.node";

const commandCenterRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(commandCenterRoot, "../..");

export default defineConfig({
  root: commandCenterRoot,
  cacheDir: path.resolve(repoRoot, ".runtime-cache/cache/vite/apps-command-center"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 17373,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${frontendNodeEnv("BACKEND_PORT", "17380")}`,
        changeOrigin: true,
      },
      "/health": {
        target: `http://127.0.0.1:${frontendNodeEnv("BACKEND_PORT", "17380")}`,
        changeOrigin: true,
      },
    },
  },
});
