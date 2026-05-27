import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadYamlFileUnderRoot } from "../../../core/src/config/loadYaml.js";
import { assertBaseUrlAllowed, loadProfileConfig, loadTargetConfig } from "./run.js";
import { startTargetRuntime } from "./target-runtime.js";

test("assertBaseUrlAllowed enforces scope domain whitelist by default", () => {
  const target = {
    name: "web-target",
    type: "web",
    driver: "playwright",
    scope: { domains: ["https://example.com"] },
  };
  assert.throws(
    () => assertBaseUrlAllowed(target as never, "https://another.example/path"),
    /allowed origins: https:\/\/example\.com/,
  );
});

test("assertBaseUrlAllowed can bypass whitelist only when allowAllUrls is true", () => {
  const target = {
    name: "web-target",
    type: "web",
    driver: "playwright",
    scope: { domains: ["https://example.com"] },
  };
  const result = assertBaseUrlAllowed(target as never, "https://another.example/path", true);
  assert.equal(result.matched, true);
  assert.equal(result.reason, "allow_all_urls");
  assert.deepEqual(result.allowedOrigins, ["https://example.com"]);
});

test("assertBaseUrlAllowed fails closed when whitelist is absent", () => {
  const target = {
    name: "web-target",
    type: "web",
    driver: "playwright",
  };
  assert.throws(
    () => assertBaseUrlAllowed(target as never, "https://another.example/path"),
    /must configure scope\.domains or set scope\.allowLocalhostAnyPort=true/,
  );
});

test("assertBaseUrlAllowed fails closed when scope domains contain invalid entries", () => {
  const target = {
    name: "web-target",
    type: "web",
    driver: "playwright",
    scope: { domains: ["not-a-url"] },
  };
  assert.throws(
    () => assertBaseUrlAllowed(target as never, "https://another.example/path"),
    /Invalid scope domain 'not-a-url' for target 'web-target'/,
  );
});

test("assertBaseUrlAllowed allows any localhost port when allowLocalhostAnyPort is enabled", () => {
  const target = {
    name: "web-any-localhost",
    type: "web",
    driver: "playwright",
    scope: { allowLocalhostAnyPort: true },
  };
  const result = assertBaseUrlAllowed(target as never, "http://127.0.0.1:17373/path");
  assert.equal(result.enabled, true);
  assert.equal(result.reason, "localhost_origin_allowed");
  assert.equal(result.requestedOrigin, "http://127.0.0.1:17373");
});

test("assertBaseUrlAllowed rejects non-localhost host when allowLocalhostAnyPort is enabled", () => {
  const target = {
    name: "web-any-localhost",
    type: "web",
    driver: "playwright",
    scope: { allowLocalhostAnyPort: true },
  };
  assert.throws(
    () => assertBaseUrlAllowed(target as never, "https://example.com"),
    /only localhost\/127\.0\.0\.1\/::1 are allowed/,
  );
});

test("assertBaseUrlAllowed rejects non-http protocols for web targets", () => {
  const target = {
    name: "web-target",
    type: "web",
    driver: "playwright",
  };
  assert.throws(
    () => assertBaseUrlAllowed(target as never, "ftp://example.com"),
    /only http\/https are supported/,
  );
});

test("assertBaseUrlAllowed remains no-op for non-web targets", () => {
  const target = {
    name: "desktop-target",
    type: "tauri",
    driver: "desktop",
  };
  const result = assertBaseUrlAllowed(target as never, "http://127.0.0.1:3000");
  assert.equal(result.reason, "non_web_target");
  assert.equal(result.enabled, false);
});

test("loadProfileConfig rejects unsafe profile name", () => {
  assert.throws(
    () => loadProfileConfig("../nightly"),
    /Invalid profile: path separators or '\.\.' are not allowed/,
  );
});

test("loadTargetConfig rejects unsafe target name", () => {
  assert.throws(
    () => loadTargetConfig("web.local/../../etc/passwd"),
    /Invalid target: path separators or '\.\.' are not allowed/,
  );
});

test("loadYamlFileUnderRoot rejects path traversal", () => {
  const workspace = mkdtempSync(join(tmpdir(), "uiq-yaml-root-"));
  const root = join(workspace, "configs");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ok.yaml"), "name: ok\n", "utf8");
  writeFileSync(join(workspace, "escape.yaml"), "name: escape\n", "utf8");

  const ok = loadYamlFileUnderRoot<{ name: string }>(root, "ok.yaml");
  assert.equal(ok.name, "ok");
  assert.throws(() => loadYamlFileUnderRoot(root, "../escape.yaml"), /escapes root/);
});

test("loadYamlFileUnderRoot rejects absolute relPath injection", () => {
  const workspace = mkdtempSync(join(tmpdir(), "uiq-yaml-root-"));
  assert.throws(() => loadYamlFileUnderRoot(workspace, "/etc/passwd"), /must be relative/);
});

test("startTargetRuntime rejects bash and sh executables", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: { web: "bash -lc 'echo hi'" },
      }),
    /not allowlisted/,
  );
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: { web: "sh -lc 'echo hi'" },
      }),
    /not allowlisted/,
  );
});

test("startTargetRuntime rejects eval-style flags", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "uiq-runtime-"));
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: { web: "node -e \"console.log('x')\"" },
      }),
    /arg '-e' is not allowed/,
  );
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: { web: "python3 -c \"print('x')\"" },
      }),
    /arg '-c' is not allowed/,
  );
  await assert.rejects(
    () =>
      startTargetRuntime({
        enabled: true,
        baseDir,
        startCommands: { web: "node --eval \"console.log('x')\"" },
      }),
    /arg '--eval' is not allowed/,
  );
});
