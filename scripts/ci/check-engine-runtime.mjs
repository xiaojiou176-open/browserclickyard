#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import YAML from "../lib/yaml-loader.mjs";

const KNOWN_ENGINES = ["crawlee", "lostpixel", "backstop", "semgrep", "k6"];

function parseArgs(argv) {
  const options = {
    profile: "pr",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--profile" && next) {
      options.profile = next;
    }
  }
  return options;
}

function loadProfile(profileName) {
  const profilePath = resolve("profiles", `${profileName}.yaml`);
  const raw = readFileSync(profilePath, "utf8");
  return YAML.parse(raw);
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      version: "",
      detail:
        result.error?.message ?? (result.stderr || result.stdout || "command_not_available").trim(),
    };
  }
  const output = (result.stdout || result.stderr || "").trim();
  return {
    available: true,
    version: output.split("\n")[0] ?? "",
    detail: "ok",
  };
}

function packageAvailable(packageName) {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const pkgRaw = JSON.parse(readFileSync(pkgPath, "utf8"));
    return {
      available: true,
      version: String(pkgRaw.version || ""),
      detail: "ok",
    };
  } catch (error) {
    return {
      available: false,
      version: "",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function detectEngineRuntime(engine) {
  switch (engine) {
    case "crawlee":
      return packageAvailable("crawlee");
    case "lostpixel":
      return packageAvailable("lost-pixel");
    case "backstop":
      return packageAvailable("backstopjs");
    case "semgrep":
      return commandVersion("semgrep");
    case "k6":
      return commandVersion("k6", ["version"]);
    default:
      return { available: false, version: "", detail: "unknown_engine" };
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = loadProfile(options.profile);
  const policy = profile?.enginePolicy ?? {};
  const required = Array.isArray(policy.required)
    ? policy.required.filter((item) => typeof item === "string" && KNOWN_ENGINES.includes(item))
    : [];
  const failOnBlocked = policy.failOnBlocked === true;

  const engineAvailability = {};
  for (const engine of KNOWN_ENGINES) {
    engineAvailability[engine] = detectEngineRuntime(engine);
  }

  const missingRequired = required.filter((engine) => !engineAvailability[engine]?.available);
  const report = {
    profile: options.profile,
    generatedAt: new Date().toISOString(),
    policy: {
      required,
      failOnBlocked,
    },
    engineAvailability,
    blockedByMissingEngineCount: missingRequired.length,
    missingRequired,
  };

  const reportPath = resolve(
    ".runtime-cache/artifacts/ci",
    `engine-runtime-${options.profile}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (missingRequired.length > 0) {
    const _message = `[engine-runtime] missing required engines: ${missingRequired.join(", ")} (profile=${options.profile})`;
    if (failOnBlocked) {
      process.exit(2);
    }
  } else {
  }
}

main();
