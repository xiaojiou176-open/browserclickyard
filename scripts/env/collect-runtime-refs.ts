import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const TARGETS = [
  "services/api/app",
  "services/api/alembic",
  "tooling/automation/scripts",
  "tooling/automation/playwright.config.ts",
  "services/mcp-server/src",
  "packages/orchestrator/src/commands",
  "apps/command-center/src",
  "apps/command-center/scripts",
  "apps/command-center/vite.config.ts",
  "scripts/run-e2e.sh",
  "scripts/test-matrix.sh",
  "scripts/usability/lane-d-usability.ts",
  "scripts/dev-up.sh",
  "scripts/ci/pre-push-local-gate.sh",
  "scripts/ci/iac-consistency-gate.sh",
] as const;

const FILE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".mjs", ".sh", ".yml", ".yaml"]);
const EXACT_SHELL_ENV_NAMES = new Set([
  "RUNTIME_GC_AUTO_ON_DEV_UP",
  "RUNTIME_GC_DIR_SIZE_THRESHOLD_MB",
  "UIQ_ALLOW_COMPOSE_SKIP",
  "UIQ_ALLOW_COMPOSE_SKIP_REASON",
  "UIQ_ALLOW_LIGHT_PREPUSH",
  "UIQ_ALLOW_LIGHT_PREPUSH_REASON",
  "UIQ_TEST_MATRIX_ALLOW_CMD_OVERRIDE",
]);

function walkFiles(path: string, output: string[]): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walkFiles(resolve(path, entry), output);
    }
    return;
  }

  const ext = path.slice(path.lastIndexOf("."));
  if (FILE_EXTENSIONS.has(ext)) {
    output.push(path);
  }
}

export function collectRuntimeEnvRefs(
  repoRoot = resolve("."),
  targets: readonly string[] = TARGETS,
): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const abs = resolve(repoRoot, target);
    try {
      walkFiles(abs, files);
    } catch {
      // optional target
    }
  }

  const refs = new Set<string>();
  const regexes = [
    /\benv_(?:str|int|float|bool|csv)\(\s*['"]([A-Z0-9_]+)['"]/g,
    /\benvEnabled\(\s*['"]([A-Z0-9_]+)['"]/g,
    /\b(?:requiredEnv|mcpEnv|mcpBool|mcpInt|orchestratorEnv|orchestratorBool|orchestratorInt|automationEnv|automationBool|automationInt|frontendNodeEnv)\(\s*['"]([A-Z0-9_]+)['"]/g,
    /\b(?:readEnv|readBoolEnv|readIntEnv|readCsvEnv)\(\s*[^,]+,\s*['"]([A-Z0-9_]+)['"]/g,
    /\b(?:read_env|read_bool_env|read_int_env|read_csv_env|_read_bool_env|_read_int_env|_read_non_negative_int_env|_read_positive_int_env)\(\s*['"]([A-Z0-9_]+)['"]/g,
    /\bcall_remote_engine\(\s*['"]([A-Z0-9_]+)['"]\s*,/g,
    /process\.env\.([A-Z0-9_]+)/g,
    /process\.env\[['"]([A-Z0-9_]+)['"]\]/g,
    /import\.meta\.env\.([A-Z0-9_]+)/g,
    /\bos\.getenv\(\s*['"]([A-Z0-9_]+)['"]/g,
    /\bos\.environ\[['"]([A-Z0-9_]+)['"]\]/g,
  ];
  const shellRegexes = [/\$\{([A-Z][A-Z0-9_]+):[-=][^}]*\}/g];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const isWorkflowYaml = file.endsWith(".yml") || file.endsWith(".yaml");
    if (!isWorkflowYaml) {
      for (const regex of regexes) {
        for (const match of content.matchAll(regex)) {
          if (match[1]) {
            refs.add(match[1]);
          }
        }
      }
    }
    for (const regex of shellRegexes) {
      for (const match of content.matchAll(regex)) {
        const name = match[1];
        if (name && EXACT_SHELL_ENV_NAMES.has(name)) {
          refs.add(name);
        }
      }
    }
  }

  return [...refs].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const refs = collectRuntimeEnvRefs();
  process.stdout.write(`${refs.join("\n")}\n`);
}
