#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();

const allowedTrackedPaths = [
  /(^|\/)\.env\.example$/,
  /^scripts\/tests\/fixtures\/runtime-log-sample\/.+\.jsonl$/,
  /^tooling\/automation\/tests\/fixtures\/.+\.har\.json$/,
];

const trackedPathRules = [
  {
    id: "tracked-env-file",
    test: (file) => /(^|\/)\.env(\..+)?$/.test(file) && !isAllowedTrackedPath(file),
  },
  {
    id: "tracked-runtime-artifact",
    test: (file) =>
      !isAllowedTrackedPath(file) &&
      ((/(^|\/)\.runtime-cache\//.test(file) ||
        /(^|\/)logs?\//.test(file) ||
        /(^|\/)test-results\//.test(file) ||
        /(^|\/)playwright-report\//.test(file) ||
        /\.(?:jsonl|log|trace)$/i.test(file) ||
        /\.har(?:\.json)?$/i.test(file))),
  },
  {
    id: "tracked-browser-session-artifact",
    test: (file) =>
      /(^|\/)(?:cookies(?:\.[^.]+)?\.json|storageState(?:\.[^.]+)?\.json)$/i.test(file),
  },
  {
    id: "tracked-database-artifact",
    test: (file) => /\.(?:db|db3|sqlite|sqlite3)$/i.test(file),
  },
  {
    id: "tracked-key-material-file",
    test: (file) => /\.(?:pem|key|p12|pfx)$/i.test(file),
  },
];

const contentAllowedFiles = {
  high_confidence_secret_pattern: new Set([
    ".gitleaks.toml",
    ".secrets.baseline",
    "scripts/acceptance/lib/redact.ts",
    "scripts/ci/check-sensitive-surface-leaks.mjs",
    "scripts/ci/secret-leak-gate.sh",
  ]),
};

const textLikeExtensions = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rst",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const contentRules = [
  {
    id: "high_confidence_secret_pattern",
    regex:
      /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    allow({ file }) {
      return contentAllowedFiles.high_confidence_secret_pattern.has(file);
    },
  },
  {
    id: "local_absolute_path",
    regex:
      /(?:^|[\s`"'(=:])((?:\/Users\/[^\s`"'()<>{}\]]+)|(?:\/home\/[^\s`"'()<>{}\]]+)|(?:\/private\/var\/folders\/[^\s`"'()<>{}\]]+)|(?:[A-Za-z]:\\Users\\[^\s`"'()<>{}\]]+))/g,
    captureGroup: 1,
    allow({ match }) {
      return (
        match.endsWith("...") ||
        match.includes("<user>") ||
        match === "/private/var/folders/..."
      );
    },
  },
  {
    id: "non_example_email",
    regex: /(?:^|[\s`"'(<{=:])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    captureGroup: 1,
    allow({ file, match }) {
      if (file === "pnpm-lock.yaml" || file === "uv.lock") {
        return true;
      }
      return (
        match === "a@b.com" ||
        /@example\.(com|org|net)$/i.test(match) ||
        /@users\.noreply\.github\.com$/i.test(match) ||
        /@localhost$/i.test(match) ||
        match === "git@github.com"
      );
    },
  },
];

function isAllowedTrackedPath(file) {
  return allowedTrackedPaths.some((pattern) => pattern.test(file));
}

function readTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTextCandidate(file) {
  if (
    file.startsWith(".git/") ||
    file.startsWith(".runtime-cache/") ||
    file.startsWith("node_modules/") ||
    file.includes("/node_modules/") ||
    file.startsWith("dist/") ||
    file.includes("/dist/") ||
    file.startsWith("build/") ||
    file.includes("/build/") ||
    file.startsWith("coverage/") ||
    file.includes("/coverage/") ||
    file.startsWith("test-results/") ||
    file.includes("/test-results/")
  ) {
    return false;
  }
  const basename = file.split("/").pop() ?? file;
  if (
    basename === "README" ||
    basename === "LICENSE" ||
    basename === ".gitignore" ||
    basename === ".gitleaks.toml" ||
    basename === ".secrets.baseline"
  ) {
    return true;
  }
  const extMatch = basename.match(/(\.[^.]+)$/);
  return extMatch ? textLikeExtensions.has(extMatch[1].toLowerCase()) : false;
}

function scanTrackedPathRules(files) {
  const failures = [];
  for (const file of files) {
    for (const rule of trackedPathRules) {
      if (rule.test(file)) {
        failures.push({
          rule: rule.id,
          file,
        });
      }
    }
  }
  return failures;
}

function scanContentRules(files) {
  const failures = [];

  for (const file of files) {
    if (!isTextCandidate(file)) {
      continue;
    }

    const absolutePath = resolve(repoRoot, file);
    let content;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of contentRules) {
        for (const match of line.matchAll(rule.regex)) {
          const rawMatch =
            rule.captureGroup !== undefined ? match[rule.captureGroup] ?? match[0] : match[0];
          if (
            rule.allow?.({
              file,
              line,
              lineNumber: index + 1,
              match: rawMatch,
            })
          ) {
            continue;
          }
          failures.push({
            rule: rule.id,
            file,
            lineNumber: index + 1,
          });
        }
      }
    });
  }

  return failures;
}

function runHarFixtureRedactionCheck() {
  try {
    execFileSync(process.execPath, ["--test", "scripts/ci/check-har-fixtures-redaction.test.mjs"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return [];
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "HAR fixture redaction test failed";
    const firstLine = stderr.split(/\r?\n/).find((line) => line.trim()) ?? stderr;
    return [
      {
        rule: "har_fixture_redaction",
        file: "scripts/ci/check-har-fixtures-redaction.test.mjs",
        detail: firstLine,
      },
    ];
  }
}

function formatFailure(failure) {
  if (failure.detail) {
    return `- ${failure.rule}: ${failure.file} (${failure.detail})`;
  }
  if (failure.lineNumber) {
    return `- ${failure.rule}: ${failure.file}:${failure.lineNumber}`;
  }
  return `- ${failure.rule}: ${failure.file}`;
}

const trackedFiles = readTrackedFiles();
const failures = [
  ...scanTrackedPathRules(trackedFiles),
  ...scanContentRules(trackedFiles),
  ...runHarFixtureRedactionCheck(),
];

if (failures.length > 0) {
  console.error("[check-sensitive-surface-leaks] FAIL");
  for (const failure of failures) {
    console.error(formatFailure(failure));
  }
  process.exit(1);
}

console.log("[check-sensitive-surface-leaks] PASS");
