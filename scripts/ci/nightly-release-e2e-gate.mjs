import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const frontendE2eDir = "apps/command-center/tests/e2e";

function parseArgs(argv) {
  const options = {
    mode: "nightly",
    nonstubReport:
      process.env.E2E_CRITICAL_NONSTUB_REPORT_PATH ||
      ".runtime-cache/artifacts/ci/nonstub-critical-report.json",
    output: process.env.E2E_NIGHTLY_RELEASE_GATE_OUTPUT || "",
  };

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg.startsWith("--nonstub-report=")) {
      options.nonstubReport = arg.slice("--nonstub-report=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode !== "nightly" && options.mode !== "release") {
    throw new Error(`--mode must be nightly or release, received: ${JSON.stringify(options.mode)}`);
  }
  return options;
}

function toPositiveNumber(raw, label) {
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, received: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function readRatioThreshold(mode) {
  const modeEnv =
    mode === "release"
      ? process.env.E2E_STUB_NONSTUB_MAX_RATIO_RELEASE
      : process.env.E2E_STUB_NONSTUB_MAX_RATIO_NIGHTLY;
  const sharedEnv = process.env.E2E_STUB_NONSTUB_MAX_RATIO;
  const fallback = mode === "release" ? "1" : "2";
  return toPositiveNumber(modeEnv ?? sharedEnv ?? fallback, "stub/non-stub ratio threshold");
}

function readPassRateThreshold(mode) {
  const modeEnv =
    mode === "release"
      ? process.env.E2E_CRITICAL_NONSTUB_PASS_RATE_MIN_RELEASE
      : process.env.E2E_CRITICAL_NONSTUB_PASS_RATE_MIN_NIGHTLY;
  const sharedEnv = process.env.E2E_CRITICAL_NONSTUB_PASS_RATE_MIN;
  const value = Number.parseFloat(String(modeEnv ?? sharedEnv ?? "1"));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `critical non-stub pass-rate threshold must be in [0, 1], received: ${JSON.stringify(modeEnv ?? sharedEnv ?? "1")}`,
    );
  }
  return value;
}

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function collectStubRatio() {
  const dir = path.join(repoRoot, frontendE2eDir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const specs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => entry.name);
  let nonStubCount = 0;

  for (const spec of specs) {
    const rel = path.posix.join(frontendE2eDir, spec);
    const content = await read(rel);
    if (/\B@nonstub\b/.test(content)) {
      nonStubCount += 1;
    }
  }

  const stubCount = Math.max(0, specs.length - nonStubCount);
  return {
    totalSpecs: specs.length,
    nonStubCount,
    stubCount,
    ratio: nonStubCount === 0 ? Number.POSITIVE_INFINITY : stubCount / nonStubCount,
    directory: frontendE2eDir,
  };
}

function collectTestsFromPlaywrightJson(node, collector) {
  if (!node || typeof node !== "object") {
    return;
  }
  const current = node;
  if (Array.isArray(current.specs)) {
    for (const spec of current.specs) {
      if (!spec || typeof spec !== "object") {
        continue;
      }
      if (!Array.isArray(spec.tests)) {
        continue;
      }
      for (const test of spec.tests) {
        if (!test || typeof test !== "object") {
          continue;
        }
        collector.push(test);
      }
    }
  }
  if (Array.isArray(current.suites)) {
    for (const suite of current.suites) {
      collectTestsFromPlaywrightJson(suite, collector);
    }
  }
}

function summarizeNonStubReport(reportJson) {
  const tests = [];
  collectTestsFromPlaywrightJson(reportJson, tests);

  const relevant = tests.filter((test) => {
    const title = String(test.title || "");
    const tags = Array.isArray(test.tags) ? test.tags.map(String) : [];
    return (
      title.includes("@nonstub") ||
      tags.includes("@nonstub") ||
      tags.includes("nonstub") ||
      tests.length === 1
    );
  });
  const scoped = relevant.length > 0 ? relevant : tests;

  let passed = 0;
  let total = 0;
  for (const test of scoped) {
    const results = Array.isArray(test.results) ? test.results : [];
    const hasPassed = results.some((result) => String(result?.status || "") === "passed");
    const fullySkipped =
      results.length > 0 && results.every((result) => String(result?.status || "") === "skipped");
    if (fullySkipped) {
      total += 1;
      continue;
    }
    total += 1;
    if (hasPassed) {
      passed += 1;
    }
  }

  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
  };
}

async function parseNonStubReport(reportPath) {
  const absolute = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath);
  let raw;
  try {
    raw = await fs.readFile(absolute, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `missing required non-stub evidence at ${reportPath}; generate it first (example: UIQ_E2E_ARTIFACT_POLICY=failure-only ./scripts/run-e2e.sh apps/command-center/tests/e2e/non-stub-core-flow.spec.ts --reporter=json > ${reportPath}). Original error: ${message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      try {
        parsed = JSON.parse(raw.slice(jsonStart));
      } catch {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid JSON in non-stub report ${reportPath}: ${message}`);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSON in non-stub report ${reportPath}: ${message}`);
    }
  }

  const summary = summarizeNonStubReport(parsed);
  if (summary.total === 0) {
    throw new Error(
      `non-stub report ${reportPath} contains 0 executable tests; cannot evaluate pass-rate gate.`,
    );
  }
  return summary;
}

function formatRatio(stubCount, nonStubCount, ratio) {
  if (!Number.isFinite(ratio)) {
    return `${stubCount}:${nonStubCount} (infinite)`;
  }
  return `${stubCount}:${nonStubCount} (${ratio.toFixed(2)}:1)`;
}

const startedAt = new Date().toISOString();
let exitCode = 0;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ratioThreshold = readRatioThreshold(options.mode);
  const passRateThreshold = readPassRateThreshold(options.mode);
  const ratioSummary = await collectStubRatio();
  const nonStubSummary = await parseNonStubReport(options.nonstubReport);
  const failures = [];

  if (ratioSummary.nonStubCount === 0) {
    failures.push(
      `[ratio-check] ${ratioSummary.directory} has 0 @nonstub specs; cannot enforce authenticity.`,
    );
  } else if (ratioSummary.ratio > ratioThreshold) {
    failures.push(
      `[ratio-check] stub/non-stub ratio ${formatRatio(ratioSummary.stubCount, ratioSummary.nonStubCount, ratioSummary.ratio)} exceeds ${ratioThreshold}:1 for mode=${options.mode}.`,
    );
  }

  if (nonStubSummary.passRate < passRateThreshold) {
    failures.push(
      `[nonstub-pass-rate] critical non-stub pass-rate ${(nonStubSummary.passRate * 100).toFixed(2)}% (${nonStubSummary.passed}/${nonStubSummary.total}) is below ${(passRateThreshold * 100).toFixed(2)}% for mode=${options.mode}.`,
    );
  }

  const payload = {
    checked_at: startedAt,
    mode: options.mode,
    thresholds: {
      stub_nonstub_max_ratio: ratioThreshold,
      critical_nonstub_pass_rate_min: passRateThreshold,
    },
    ratio: ratioSummary,
    critical_nonstub: nonStubSummary,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };

  const outputPath =
    options.output ||
    path.posix.join(".runtime-cache/artifacts/ci", `nightly-release-e2e-gate-${options.mode}.json`);
  const outputAbs = path.isAbsolute(outputPath) ? outputPath : path.join(repoRoot, outputPath);
  await fs.mkdir(path.dirname(outputAbs), { recursive: true });
  await fs.writeFile(outputAbs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (failures.length > 0) {
    for (const _failure of failures) {
    }
    exitCode = 1;
  } else {
  }
}

try {
  await main();
} catch (error) {
  const _message = error instanceof Error ? error.message : String(error);
  exitCode = 1;
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
