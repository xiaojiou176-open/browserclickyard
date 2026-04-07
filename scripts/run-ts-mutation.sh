#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/lib/node-toolchain.sh"
uiq_export_node_env "$ROOT_DIR"
DEFAULT_TARGET_SPEC="services/mcp-server/src/core/registry.ts,services/mcp-server/src/core/redaction.ts"
TARGET_SPEC="${UIQ_TS_MUTATE_TARGET:-$DEFAULT_TARGET_SPEC}"
MUTATION_TIMEOUT_SECONDS="${UIQ_TS_MUTATION_TIMEOUT_SECONDS:-900}"
MUTATION_MAX_TIMEOUTS="${UIQ_MUTATION_TS_MAX_TIMEOUTS:-0}"
MUTATION_MAX_NO_COVERAGE="${UIQ_MUTATION_TS_MAX_NO_COVERAGE:-0}"

normalize_target_item() {
  local raw="$1"
  local item="${raw#"${raw%%[![:space:]]*}"}"
  item="${item%"${item##*[![:space:]]}"}"
  if [[ -z "$item" ]]; then
    return 1
  fi
  local target_file="${item%%:*}"
  if [[ "$target_file" == "$ROOT_DIR/"* ]]; then
    target_file="${target_file#"$ROOT_DIR"/}"
  fi
  if [[ "$item" == *":"* ]]; then
    echo "[mutation] UIQ_TS_MUTATE_TARGET contains line range; Stryker mutate uses file-level globs only. Using '$target_file'." >&2
  fi
  if [[ ! -f "$ROOT_DIR/$target_file" ]]; then
    echo "Mutation target file not found: $target_file (from: $item)" >&2
    exit 1
  fi
  printf "%s" "$target_file"
}

TARGETS=()
IFS=',' read -r -a RAW_TARGETS <<< "$TARGET_SPEC"
for raw_target in "${RAW_TARGETS[@]}"; do
  if normalized="$(normalize_target_item "$raw_target")"; then
    TARGETS+=("$normalized")
  fi
done

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "Mutation target list resolved to empty set: $TARGET_SPEC" >&2
  exit 1
fi

if ! [[ "$MUTATION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [[ "$MUTATION_TIMEOUT_SECONDS" -lt 60 ]]; then
  echo "[mutation] UIQ_TS_MUTATION_TIMEOUT_SECONDS must be an integer >= 60 (current: $MUTATION_TIMEOUT_SECONDS)" >&2
  exit 1
fi

if ! [[ "$MUTATION_MAX_TIMEOUTS" =~ ^[0-9]+$ ]] || ! [[ "$MUTATION_MAX_NO_COVERAGE" =~ ^[0-9]+$ ]]; then
  echo "[mutation] UIQ_MUTATION_TS_MAX_TIMEOUTS/UIQ_MUTATION_TS_MAX_NO_COVERAGE must be integers >= 0" >&2
  exit 1
fi

TARGET_BACKUP_DIR="$(mktemp -d)"
backup_path_for_target() {
  local target_file="$1"
  local safe_name="${target_file//\//__}"
  printf "%s/%s.bak" "$TARGET_BACKUP_DIR" "$safe_name"
}
cleanup_target() {
  for target_file in "${TARGETS[@]}"; do
    local backup_file
    backup_file="$(backup_path_for_target "$target_file")"
    if [[ -f "$backup_file" ]]; then
      cp "$backup_file" "$ROOT_DIR/$target_file"
    fi
  done
  if [[ -d "$TARGET_BACKUP_DIR" ]]; then
    rm -rf "$TARGET_BACKUP_DIR"
  fi
}
trap cleanup_target EXIT
for target_file in "${TARGETS[@]}"; do
  cp "$ROOT_DIR/$target_file" "$(backup_path_for_target "$target_file")"
done

# Equivalent lint guard: catches obvious conditional expect and expect-less test files
# used by the mutation suite to reduce false-green risk.
if [[ "${UIQ_SKIP_EXPECT_GUARD:-0}" != "1" ]]; then
  node - "$ROOT_DIR" <<'NODE'
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = process.argv[2];
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const testCmd = pkg?.scripts?.["mcp:test:mutation"] ?? "";
const testFiles = testCmd
  .split(/\s+/)
  .filter((token) => token.endsWith(".test.ts"))
  .map((file) => resolve(root, file));

if (testFiles.length === 0) {
  throw new Error("Expect guard failed: no *.test.ts files found in scripts.mcp:test:mutation");
}

const conditionalExpectPatterns = [
  /\bif\s*\([^)]*\)\s*{[^{}]*\bassert\.[A-Za-z_]\w*\s*\(/s,
  /\bif\s*\([^)]*\)\s*\bassert\.[A-Za-z_]\w*\s*\(/s,
  /\bif\s*\([^)]*\)\s*{[^{}]*\bexpect\s*\(/s,
  /\bif\s*\([^)]*\)\s*\bexpect\s*\(/s,
  /\?.{0,120}\bexpect\s*\(/s,
  /\?.{0,120}\bassert\.[A-Za-z_]\w*\s*\(/s
];

for (const file of testFiles) {
  const content = readFileSync(file, "utf8");
  if (!/\bexpect\s*\(/.test(content) && !/\bassert\.[A-Za-z_]\w*\s*\(/.test(content)) {
    throw new Error(`Expect guard failed: missing assertion (expect/assert) in ${file}`);
  }
  if (conditionalExpectPatterns.some((pattern) => pattern.test(content))) {
    throw new Error(
      `Expect guard failed: detected conditional expect() pattern in ${file}. ` +
        "Refactor to unconditional assertions."
    );
  }
}

console.log(`[mutation][guard] assertion lint passed for ${testFiles.length} file(s).`);
NODE
fi

cd "$ROOT_DIR"
export UIQ_TS_MUTATE_TARGET="$(IFS=,; echo "${TARGETS[*]}")"
node - "$ROOT_DIR" "$MUTATION_TIMEOUT_SECONDS" <<'NODE'
const { spawn } = require("node:child_process");

const root = process.argv[2];
const timeoutSeconds = Number(process.argv[3]);
const timeoutMs = timeoutSeconds * 1000;

const child = spawn("bash", ["scripts/lib/node-bin.sh", "stryker", "run", "configs/testing/stryker.config.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=3072"
  }
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`[mutation][ts] timeout reached (${timeoutSeconds}s); terminating Stryker process...`);
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 10000).unref();
}, timeoutMs);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    process.exit(124);
  }
  if (signal) {
    console.error(`[mutation][ts] stryker terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`[mutation][ts] failed to start Stryker: ${err?.message ?? err}`);
  process.exit(1);
});
NODE

node - "$ROOT_DIR" <<'NODE'
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = process.argv[2];
const summaryPath = resolve(root, ".runtime-cache/reports/mutation/ts/summary.json");
const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
let killed = 0;
let survived = 0;
let timeout = 0;
let noCoverage = 0;
let runtimeErrors = 0;
for (const file of Object.values(raw.files ?? {})) {
  for (const mutant of file.mutants ?? []) {
    if (mutant.status === "Killed") killed += 1;
    if (mutant.status === "Survived") survived += 1;
    if (mutant.status === "Timeout") timeout += 1;
    if (mutant.status === "NoCoverage") noCoverage += 1;
    if (mutant.status === "RuntimeError") runtimeErrors += 1;
  }
}
const effective = killed + survived > 0;
if (!effective) {
  throw new Error(`[mutation][ts] hard gate failed: no effective mutants in ${summaryPath}`);
}
const score = Number(((killed / (killed + survived)) * 100).toFixed(2));
const minScore = Number.parseFloat(process.env.UIQ_MUTATION_TS_MIN_SCORE ?? "100");
if (score < minScore) {
  throw new Error(
    `[mutation][ts] hard gate failed: score=${score}% below minimum ${minScore}%`,
  );
}
const maxTimeouts = Number.parseInt(process.env.UIQ_MUTATION_TS_MAX_TIMEOUTS ?? "0", 10);
const maxNoCoverage = Number.parseInt(process.env.UIQ_MUTATION_TS_MAX_NO_COVERAGE ?? "0", 10);
if (timeout > maxTimeouts) {
  throw new Error(
    `[mutation][ts] hard gate failed: timeout mutants=${timeout} exceeds max ${maxTimeouts}`,
  );
}
if (noCoverage > maxNoCoverage) {
  throw new Error(
    `[mutation][ts] hard gate failed: no-coverage mutants=${noCoverage} exceeds max ${maxNoCoverage}`,
  );
}
if (runtimeErrors > 0) {
  throw new Error(
    `[mutation][ts] hard gate failed: runtime error mutants=${runtimeErrors} (must be 0)`,
  );
}
if (survived > 0) {
  console.warn(
    `[mutation][ts] warning: survived mutants detected (${survived}). ` +
      "See .runtime-cache/reports/mutation/ts/html/index.html and summary.json for details.",
  );
}
console.log(
  `[mutation][ts] hard gate passed (score=${score}%, killed=${killed}, survived=${survived}, timeout=${timeout}, noCoverage=${noCoverage}, runtimeErrors=${runtimeErrors}, min=${minScore}%).`,
);
NODE
