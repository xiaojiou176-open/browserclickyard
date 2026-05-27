import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const nonStubSpec = "tests/frontend-e2e/non-stub-core-flow.spec.ts";
const criticalSpecs = [
  "tests/frontend-e2e/first-use-guardrails.spec.ts",
  "tests/frontend-e2e/critical-buttons.spec.ts",
];
const frontendE2eDir = "tests/frontend-e2e";
const ratioCheckDirs = ["apps/command-center/tests/e2e", "tests/frontend-e2e"];
const stubToNonStubMaxRatio = Number.parseFloat(process.env.E2E_STUB_NONSTUB_MAX_RATIO ?? "4");
const nonStubScriptName = "test:e2e:frontend:nonstub";
const criticalScriptName = "test:e2e:frontend:critical";
const brittleClassLocatorPattern = /\b(?:page\.)?locator\(\s*["'][.][^"']+["']/g;
const brittleStructureLocatorPattern =
  /\b(?:page\.)?locator\(\s*["'][^"']*(?:nth-child|first-child|last-child|:has\()[^"']*["']/g;

function collectMatches(content, pattern) {
  const matches = [];
  let match = pattern.exec(content);
  while (match) {
    matches.push(match);
    match = pattern.exec(content);
  }
  return matches;
}

async function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return fs.readFile(absolutePath, "utf8");
}

async function listSpecFiles(relativeDir) {
  const root = path.join(repoRoot, relativeDir);
  const files = [];

  async function walk(currentDir, relativePrefix = "") {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const nextPrefix = relativePrefix ? path.posix.join(relativePrefix, entry.name) : entry.name;
      const nextAbsolute = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(nextAbsolute, nextPrefix);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        files.push(path.posix.join(relativeDir, nextPrefix));
      }
    }
  }

  await walk(root);
  return files;
}

const failures = [];
const ratioAuditResults = [];

let packageJsonContent = "";
try {
  packageJsonContent = await read("package.json");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`[routing-check] unable to read package.json: ${message}`);
}

if (packageJsonContent) {
  let packageJson = {};
  try {
    packageJson = JSON.parse(packageJsonContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`[routing-check] package.json is not valid JSON: ${message}`);
  }

  const scripts = packageJson && typeof packageJson === "object" ? packageJson.scripts : undefined;
  const nonStubScript =
    typeof scripts?.[nonStubScriptName] === "string" ? scripts[nonStubScriptName].trim() : "";
  const criticalScript =
    typeof scripts?.[criticalScriptName] === "string" ? scripts[criticalScriptName].trim() : "";

  if (!nonStubScript) {
    failures.push(`[routing-check] missing or empty package.json script: ${nonStubScriptName}.`);
  }
  if (!criticalScript) {
    failures.push(`[routing-check] missing or empty package.json script: ${criticalScriptName}.`);
  }

  if (nonStubScript && criticalScript && nonStubScript === criticalScript) {
    failures.push(
      `[routing-check] ${nonStubScriptName} and ${criticalScriptName} must route to different test targets, but their script values are identical.`,
    );
  }

  if (nonStubScript && !nonStubScript.includes("@frontend-nonstub|@nonstub")) {
    failures.push(
      `[routing-check] ${nonStubScriptName} must include grep selector @frontend-nonstub|@nonstub.`,
    );
  }

  if (
    criticalScript &&
    !criticalScript.includes("@frontend-critical-buttons|@frontend-first-use")
  ) {
    failures.push(
      `[routing-check] ${criticalScriptName} must include grep selector @frontend-critical-buttons|@frontend-first-use.`,
    );
  }
}

let nonStubContent = "";
try {
  nonStubContent = await read(nonStubSpec);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`[non-stub] unable to read ${nonStubSpec}: ${message}`);
}

if (nonStubContent && !/\B@nonstub\b/.test(nonStubContent)) {
  failures.push(`[non-stub] ${nonStubSpec} must include at least one @nonstub test tag.`);
}

for (const spec of criticalSpecs) {
  let content = "";
  try {
    content = await read(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`[critical-check] unable to read ${spec}: ${message}`);
    continue;
  }

  if (/\btest\.skip\s*\(/.test(content)) {
    failures.push(
      `[critical-check] ${spec} contains test.skip(...); required critical paths must fail loudly instead of skipping.`,
    );
  }
}

let frontendE2eSpecs = [];
try {
  frontendE2eSpecs = await listSpecFiles(frontendE2eDir);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`[frontend-e2e] unable to list ${frontendE2eDir}: ${message}`);
}

const frontendE2ENonStubSpecs = [];
for (const spec of frontendE2eSpecs) {
  let content = "";
  try {
    content = await read(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`[frontend-e2e] unable to read ${spec}: ${message}`);
    continue;
  }

  if (/\btest\.skip\s*\(/.test(content)) {
    failures.push(
      `[frontend-e2e] ${spec} contains test.skip(...); frontend-e2e suite must fail loudly instead of skipping.`,
    );
  }

  const waitCalls = collectMatches(content, /\bpage\.waitForTimeout\s*\(/g);
  if (waitCalls.length > 0) {
    failures.push(
      `[frontend-e2e] ${spec} contains page.waitForTimeout; use explicit condition waits instead.`,
    );
  }
  const timerSleepCalls = collectMatches(content, /\bsetTimeout\s*\(\s*resolve\s*,\s*\d+/g);
  if (timerSleepCalls.length > 0) {
    failures.push(
      `[frontend-e2e] ${spec} contains Promise/setTimeout sleep; use expect.poll or deterministic condition waits.`,
    );
  }
  const nodeTimerSleepCalls = collectMatches(content, /\bawait\s+setTimeout\s*\(\s*\d+/g);
  if (nodeTimerSleepCalls.length > 0) {
    failures.push(
      `[frontend-e2e] ${spec} contains await setTimeout(N) hard wait; use deterministic condition waits.`,
    );
  }
  const brittleClassLocators = collectMatches(content, brittleClassLocatorPattern);
  if (brittleClassLocators.length > 0) {
    failures.push(
      `[frontend-e2e] ${spec} contains class-based locator(...); prefer getByRole/getByLabel/getByTestId.`,
    );
  }
  const brittleStructureLocators = collectMatches(content, brittleStructureLocatorPattern);
  if (brittleStructureLocators.length > 0) {
    failures.push(
      `[frontend-e2e] ${spec} contains structure-coupled locator(...); avoid nth-child/first-child/last-child/:has in E2E.`,
    );
  }

  if (/\B@nonstub\b/.test(content)) {
    frontendE2ENonStubSpecs.push(spec);
    if (/\bpage\.route\s*\(/.test(content)) {
      failures.push(
        `[frontend-e2e] ${spec} is tagged @nonstub but still uses page.route(...); nonstub specs must use a real API path.`,
      );
    }
    if (/\bpage\.goto\s*\(/.test(content)) {
      const hasAfterEach = /\btest\.afterEach\s*\(/.test(content);
      const hasCleanup =
        /\bcontext\.clearCookies\s*\(/.test(content) ||
        /\blocalStorage\.clear\s*\(\s*\)/.test(content) ||
        /\bsessionStorage\.clear\s*\(\s*\)/.test(content);
      if (!hasAfterEach || !hasCleanup) {
        failures.push(
          `[frontend-e2e] ${spec} is @nonstub with UI navigation but lacks explicit afterEach cleanup (cookies/storage).`,
        );
      }
    }
  }
}

if (frontendE2eSpecs.length > 0 && frontendE2ENonStubSpecs.length === 0) {
  failures.push(
    `[frontend-e2e] ${frontendE2eDir} has 0 @nonstub specs; add at least one real nonstub spec with @nonstub tag.`,
  );
}

if (!Number.isFinite(stubToNonStubMaxRatio) || stubToNonStubMaxRatio <= 0) {
  failures.push(
    `[ratio-check] E2E_STUB_NONSTUB_MAX_RATIO must be a positive number, received ${JSON.stringify(process.env.E2E_STUB_NONSTUB_MAX_RATIO ?? "4")}.`,
  );
} else {
  for (const dir of ratioCheckDirs) {
    const absoluteDir = path.join(repoRoot, dir);
    try {
      await fs.access(absoluteDir);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        ratioAuditResults.push({
          dir,
          status: "missing",
          stubCount: 0,
          nonStubCount: 0,
          ratioText: "n/a",
        });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`[ratio-check] unable to access ${dir}: ${message}`);
      continue;
    }

    let specFiles = [];
    try {
      specFiles = await listSpecFiles(dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`[ratio-check] unable to list ${dir}: ${message}`);
      continue;
    }

    if (specFiles.length === 0) {
      ratioAuditResults.push({
        dir,
        status: "empty",
        stubCount: 0,
        nonStubCount: 0,
        ratioText: "n/a",
      });
      continue;
    }

    let nonStubCount = 0;
    for (const spec of specFiles) {
      try {
        const content = await read(spec);
        if (dir !== frontendE2eDir) {
          const waitCalls = collectMatches(content, /\bpage\.waitForTimeout\s*\(/g);
          if (waitCalls.length > 0) {
            failures.push(
              `[ratio-check] ${spec} contains page.waitForTimeout; use explicit condition waits instead.`,
            );
          }
          const timerSleepCalls = collectMatches(content, /\bsetTimeout\s*\(\s*resolve\s*,\s*\d+/g);
          if (timerSleepCalls.length > 0) {
            failures.push(
              `[ratio-check] ${spec} contains Promise/setTimeout sleep; use expect.poll or deterministic condition waits.`,
            );
          }
          const nodeTimerSleepCalls = collectMatches(content, /\bawait\s+setTimeout\s*\(\s*\d+/g);
          if (nodeTimerSleepCalls.length > 0) {
            failures.push(
              `[ratio-check] ${spec} contains await setTimeout(N) hard wait; use deterministic condition waits.`,
            );
          }
          const brittleClassLocators = collectMatches(content, brittleClassLocatorPattern);
          if (brittleClassLocators.length > 0) {
            failures.push(
              `[ratio-check] ${spec} contains class-based locator(...); prefer getByRole/getByLabel/getByTestId.`,
            );
          }
          const brittleStructureLocators = collectMatches(content, brittleStructureLocatorPattern);
          if (brittleStructureLocators.length > 0) {
            failures.push(
              `[ratio-check] ${spec} contains structure-coupled locator(...); avoid nth-child/first-child/last-child/:has in E2E.`,
            );
          }
        }
        if (/\B@nonstub\b/.test(content)) {
          nonStubCount += 1;
          if (/\bpage\.goto\s*\(/.test(content)) {
            const hasAfterEach = /\btest\.afterEach\s*\(/.test(content);
            const hasCleanup =
              /\bcontext\.clearCookies\s*\(/.test(content) ||
              /\blocalStorage\.clear\s*\(\s*\)/.test(content) ||
              /\bsessionStorage\.clear\s*\(\s*\)/.test(content);
            if (!hasAfterEach || !hasCleanup) {
              failures.push(
                `[ratio-check] ${spec} is @nonstub with UI navigation but lacks explicit afterEach cleanup (cookies/storage).`,
              );
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`[ratio-check] unable to read ${spec}: ${message}`);
      }
    }

    const stubCount = Math.max(0, specFiles.length - nonStubCount);
    if (nonStubCount === 0) {
      failures.push(`[ratio-check] ${dir} has 0 non-stub specs; add at least one @nonstub spec.`);
      ratioAuditResults.push({
        dir,
        status: "no-nonstub",
        stubCount,
        nonStubCount,
        ratioText: "inf",
      });
      continue;
    }

    const ratio = stubCount / nonStubCount;
    ratioAuditResults.push({
      dir,
      status: ratio > stubToNonStubMaxRatio ? "exceeded" : "ok",
      stubCount,
      nonStubCount,
      ratioText: `${ratio.toFixed(2)}:1`,
    });
    if (ratio > stubToNonStubMaxRatio) {
      failures.push(
        `[ratio-check] stub/non-stub ratio ${stubCount}:${nonStubCount} (${ratio.toFixed(2)}:1) exceeds ${stubToNonStubMaxRatio}:1 in ${dir}.`,
      );
    }
  }
}

for (const result of ratioAuditResults) {
  console.info(
    `[ratio-audit] ${result.dir} status=${result.status} stub=${result.stubCount} nonStub=${result.nonStubCount} ratio=${result.ratioText}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}
