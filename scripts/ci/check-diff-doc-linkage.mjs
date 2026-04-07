#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DOC_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "docs/architecture.md",
  "docs/reference/universal-api.md",
  "docs/reference/configuration.md",
  "docs/reference/dependency-governance.md",
]);

const failures = [];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizePath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .trim();
}

function parseArgs(argv) {
  const options = {
    base: process.env.UIQ_DOC_LINKAGE_BASE || "",
    head: process.env.UIQ_DOC_LINKAGE_HEAD || "HEAD",
    changedFiles: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--base" && next) {
      options.base = next;
      i += 1;
      continue;
    }
    if (token === "--head" && next) {
      options.head = next;
      i += 1;
      continue;
    }
    if (token === "--changed-files" && next) {
      options.changedFiles = next
        .split(",")
        .map((part) => normalizePath(part))
        .filter(Boolean);
      i += 1;
    }
  }

  return options;
}

function resolveBaseRef(preferred) {
  if (preferred) {
    return preferred;
  }

  const fromGithub = process.env.GITHUB_BASE_REF;
  if (fromGithub) {
    const candidate = `origin/${fromGithub}`;
    try {
      git(["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // fall through
    }
  }

  const candidates = ["origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    try {
      git(["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      // keep trying
    }
  }
  return "";
}

function resolveChangedFiles(options) {
  if (options.changedFiles.length > 0) {
    return options.changedFiles;
  }

  if (process.env.UIQ_DOC_LINKAGE_CHANGED_FILES) {
    return process.env.UIQ_DOC_LINKAGE_CHANGED_FILES.split(",")
      .map((part) => normalizePath(part))
      .filter(Boolean);
  }

  try {
    const staged = git(["diff", "--cached", "--name-only"]);
    if (staged) {
      return staged
        .split(/\r?\n/)
        .map((line) => normalizePath(line))
        .filter(Boolean);
    }
  } catch {
    // fall through
  }

  const baseRef = resolveBaseRef(options.base);
  if (!baseRef) {
    try {
      return git(["diff", "--name-only", "HEAD~1..HEAD"])
        .split(/\r?\n/)
        .map((line) => normalizePath(line))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    const mergeBase = git(["merge-base", options.head, baseRef]);
    const raw = git(["diff", "--name-only", `${mergeBase}..${options.head}`]);
    return raw
      .split(/\r?\n/)
      .map((line) => normalizePath(line))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function startsWithAny(filePath, prefixes) {
  return prefixes.some((prefix) => filePath === prefix || filePath.startsWith(prefix));
}

function hasAnyDocUpdate(changedDocs, requiredDocs) {
  return (
    requiredDocs.some((docPath) => changedDocs.has(docPath)) ||
    [...changedDocs].some((docPath) => docPath.startsWith("docs/"))
  );
}

function detectSignatureDiff(changedFiles, options) {
  const codeTargets = changedFiles.filter((filePath) =>
    /\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(filePath),
  );
  if (codeTargets.length === 0) {
    return false;
  }

  const diffArgs = ["diff", "--unified=0"];
  const baseRef = resolveBaseRef(options.base);
  if (baseRef) {
    diffArgs.push(`${baseRef}...${options.head}`, "--");
  } else {
    diffArgs.push("HEAD~1..HEAD", "--");
  }
  diffArgs.push(...codeTargets);

  let diffText = "";
  try {
    diffText = git(diffArgs);
  } catch {
    return false;
  }

  const signatureRegexes = [
    /^[+-]\s*(async\s+)?def\s+[A-Za-z_]\w*\s*\(/m,
    /^[+-]\s*(export\s+)?(async\s+)?function\s+[A-Za-z_]\w*\s*\(/m,
    /^[+-]\s*(export\s+)?const\s+[A-Za-z_]\w*\s*=\s*(async\s*)?\([^)]*\)\s*=>/m,
    /^[+-]\s*(public\s+|private\s+|protected\s+)?(async\s+)?[A-Za-z_]\w*\s*\([^)]*\)\s*[:{]/m,
  ];
  return signatureRegexes.some((regex) => regex.test(diffText));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const changedFiles = resolveChangedFiles(options);
  if (changedFiles.length === 0) {
    process.exit(0);
  }

  const changedDocs = new Set(
    changedFiles.filter((filePath) => filePath.startsWith("docs/") || DOC_FILES.has(filePath)),
  );

  const apiTouched = changedFiles.some((filePath) =>
    startsWithAny(filePath, [
      "services/api/app/api/",
      "contracts/",
      "tests/web-harness/src/api-gen/",
      "scripts/check-openapi-doc-contract.py",
    ]),
  );
  const envTouched = changedFiles.some((filePath) =>
    startsWithAny(filePath, [
      ".env.example",
      "configs/env/",
      "scripts/env/",
      "scripts/config/generate-env-example.mjs",
      "services/api/app/core/settings.py",
    ]),
  );
  const depTouched = changedFiles.some((filePath) =>
    [
      "package.json",
      "pnpm-lock.yaml",
      "uv.lock",
      "pyproject.toml",
      "tooling/automation/package.json",
      "apps/command-center/package.json",
    ].includes(filePath),
  );
  const signatureTouched = detectSignatureDiff(changedFiles, options);

  const checks = [
    {
      id: "api-change-doc-linkage",
      active: apiTouched,
      docs: ["docs/reference/universal-api.md", "docs/architecture.md", "README.md"],
    },
    {
      id: "function-signature-doc-linkage",
      active: signatureTouched,
      docs: [
        "docs/reference/universal-api.md",
        "docs/reference/configuration.md",
        "docs/architecture.md",
      ],
    },
    {
      id: "env-change-doc-linkage",
      active: envTouched,
      docs: ["docs/reference/configuration.md", "README.md"],
    },
    {
      id: "dependency-change-doc-linkage",
      active: depTouched,
      docs: ["docs/reference/dependency-governance.md", "CHANGELOG.md"],
    },
  ];

  for (const check of checks) {
    if (!check.active) {
      continue;
    }
    if (!hasAnyDocUpdate(changedDocs, check.docs)) {
      failures.push(`${check.id}: required docs missing, expected one of ${check.docs.join(", ")}`);
    }
  }

  if (failures.length > 0) {
    failures.forEach((failure) => {
      process.stderr.write(`${failure}\n`);
    });
    process.exit(1);
  }
}

main();
