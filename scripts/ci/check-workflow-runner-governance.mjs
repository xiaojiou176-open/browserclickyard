import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CACHE_ENV_NAMES = [
  "PRE_COMMIT_HOME",
  "PIP_CACHE_DIR",
  "UV_CACHE_DIR",
  "PNPM_STORE_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TMPDIR",
  "npm_config_cache",
];

const ALLOWED_GITHUB_HOSTED_LABELS = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "macos-latest",
  "macos-14",
]);

const FORBIDDEN_CACHE_PATH_RULES = [
  {
    pattern: /(?:^|["'\s])~\/\.cache\/(?:[^"'\s]+)(?:["'\s]|$)/,
    message: "actions/cache path must not point to literal ~/.cache/*",
  },
  {
    pattern: /(?:\$\{\{\s*github\.workspace\s*\}\}|\$GITHUB_WORKSPACE)/,
    message: "actions/cache path must not point into github.workspace",
  },
  {
    pattern: /(?:^|["'\s])(?:\.\/|\.runtime-cache\/|\.cache\/|cache\/|dist\/|build\/)/,
    message: "actions/cache path must not use a relative cache path inside the checkout",
  },
];

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--root requires a path");
      }
      options.root = resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function listYamlFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => join(dir, entry))
    .sort();
}

function listCompositeActionFiles(root) {
  const actionsDir = join(root, ".github/actions");
  if (!existsSync(actionsDir)) {
    return [];
  }

  return readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(actionsDir, entry.name, "action.yml"))
    .filter((file) => existsSync(file))
    .sort();
}

function makeRelative(root, file) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

function pushViolation(violations, file, message, line = null) {
  violations.push({
    file,
    line,
    message,
  });
}

function isAllowedGithubHostedRunsOn(value) {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return ALLOWED_GITHUB_HOSTED_LABELS.has(normalized);
}

function findLine(raw, pattern) {
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      return index + 1;
    }
  }
  return null;
}

function checkForbiddenRunnerRegistration(raw, file, violations) {
  const patterns = [
    { label: "config.sh", regex: /(^|[^A-Za-z0-9_./-])config\.sh([^A-Za-z0-9_-]|$)/ },
    { label: "./run.sh", regex: /(^|[^A-Za-z0-9_./-])\.\/run\.sh([^A-Za-z0-9_-]|$)/ },
    { label: "remove.sh", regex: /(^|[^A-Za-z0-9_./-])remove\.sh([^A-Za-z0-9_-]|$)/ },
  ];

  for (const { label, regex } of patterns) {
    const line = findLine(raw, regex);
    if (line) {
      pushViolation(
        violations,
        file,
        `forbidden runner registration command detected: ${label}`,
        line,
      );
    }
  }
}

function checkCacheAssignments(raw, file, violations) {
  for (const envName of CACHE_ENV_NAMES) {
    const homePattern =
      envName === "PRE_COMMIT_HOME"
        ? new RegExp(`\\b${envName}\\b\\s*[:=]\\s*["']?~\\/\\.cache\\/pre-commit(?:["'\\s]|$)`)
        : null;
    if (homePattern) {
      const line = findLine(raw, homePattern);
      if (line) {
        pushViolation(
          violations,
          file,
          `${envName} must not point to literal ~/.cache/pre-commit`,
          line,
        );
      }
    }

    const workspacePattern = new RegExp(
      `\\b${envName}\\b\\s*[:=]\\s*["']?(?:\\$\\{\\{\\s*github\\.workspace\\s*\\}\\}|\\$GITHUB_WORKSPACE)`,
    );
    const workspaceLine = findLine(raw, workspacePattern);
    if (workspaceLine) {
      pushViolation(
        violations,
        file,
        `${envName} must not point into github.workspace`,
        workspaceLine,
      );
    }

    const relativePattern = new RegExp(
      `\\b${envName}\\b\\s*[:=]\\s*["']?(?:\\.\\/|\\.runtime-cache\\/|\\.cache\\/|cache\\/|dist\\/|build\\/)`,
    );
    const relativeLine = findLine(raw, relativePattern);
    if (relativeLine) {
      pushViolation(
        violations,
        file,
        `${envName} must not use a relative cache path inside the checkout`,
        relativeLine,
      );
    }
  }
}

function checkWorkflowRunsOn(root, file, violations) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  let inJobs = false;
  let currentJobName = null;
  let currentJobLine = null;
  let currentJobSawRunsOn = false;

  const flushJob = () => {
    if (currentJobName && !currentJobSawRunsOn) {
      pushViolation(
        violations,
        makeRelative(root, file),
        `job '${currentJobName}' must use a GitHub-hosted runner label`,
        currentJobLine,
      );
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!inJobs) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
      }
      continue;
    }

    if (/^[^\s#]/.test(line) && !/^jobs:\s*$/.test(line)) {
      flushJob();
      break;
    }

    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      flushJob();
      currentJobName = jobMatch[1];
      currentJobLine = index + 1;
      currentJobSawRunsOn = false;
      continue;
    }

    if (!currentJobName) {
      continue;
    }

    const runsOnListMatch = line.match(/^ {4}runs-on:\s*\[(.+)\]\s*$/);
    if (runsOnListMatch) {
      const runsOn = runsOnListMatch[1]
        .split(",")
        .map((value) => value.trim().replace(/^["']|["']$/g, ""));
      currentJobSawRunsOn = true;
      if (runsOn.length !== 1 || !ALLOWED_GITHUB_HOSTED_LABELS.has(runsOn[0])) {
        pushViolation(
          violations,
          makeRelative(root, file),
          `job '${currentJobName}' must use a GitHub-hosted runner label`,
          index + 1,
        );
      }
      continue;
    }

    const runsOnScalarMatch = line.match(/^ {4}runs-on:\s*(.+)\s*$/);
    if (runsOnScalarMatch) {
      const rawValue = runsOnScalarMatch[1].trim();
      currentJobSawRunsOn = true;
      if (!isAllowedGithubHostedRunsOn(rawValue)) {
        pushViolation(
          violations,
          makeRelative(root, file),
          `job '${currentJobName}' must use a GitHub-hosted runner label`,
          index + 1,
        );
      }
    }
  }

  flushJob();
}

function checkExplicitCheckoutClean(raw, file, violations) {
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/- uses:\s+actions\/checkout@/.test(lines[index])) {
      continue;
    }

    let cursor = index + 1;
    let inWithBlock = false;
    let hasCleanTrue = false;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!/^\s+/.test(line)) {
        break;
      }
      if (/^\s+with:\s*$/.test(line)) {
        inWithBlock = true;
      } else if (inWithBlock && /^\s+clean:\s*true\s*$/.test(line)) {
        hasCleanTrue = true;
        break;
      }
      cursor += 1;
    }

    if (!hasCleanTrue) {
      pushViolation(
        violations,
        file,
        "actions/checkout must declare with.clean: true explicitly",
        index + 1,
      );
    }
  }
}

function checkActionsCachePaths(raw, file, violations) {
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/- uses:\s+actions\/cache@/.test(lines[index])) {
      continue;
    }

    let cursor = index + 1;
    let inWithBlock = false;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!/^\s+/.test(line)) {
        break;
      }

      if (/^\s+with:\s*$/.test(line)) {
        inWithBlock = true;
        cursor += 1;
        continue;
      }

      if (!inWithBlock) {
        cursor += 1;
        continue;
      }

      const pathMatch = line.match(/^(\s+)path:\s*(.*)$/);
      if (!pathMatch) {
        cursor += 1;
        continue;
      }

      const pathIndent = pathMatch[1].length;
      const entries = [];
      const initialValue = pathMatch[2].trim();
      if (initialValue && initialValue !== "|" && initialValue !== ">") {
        entries.push({ line: cursor + 1, value: initialValue });
      } else {
        let pathCursor = cursor + 1;
        while (pathCursor < lines.length) {
          const pathLine = lines[pathCursor];
          const indentMatch = pathLine.match(/^(\s*)(.*)$/);
          const indentLength = indentMatch ? indentMatch[1].length : 0;
          if (indentLength <= pathIndent) {
            break;
          }
          const value = pathLine.trim();
          if (value) {
            entries.push({ line: pathCursor + 1, value });
          }
          pathCursor += 1;
        }
      }

      for (const entry of entries) {
        for (const rule of FORBIDDEN_CACHE_PATH_RULES) {
          if (rule.pattern.test(entry.value)) {
            pushViolation(violations, file, rule.message, entry.line);
          }
        }
      }

      cursor += 1;
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const workflowFiles = listYamlFiles(join(options.root, ".github/workflows"));
  const actionFiles = listCompositeActionFiles(options.root);
  const violations = [];

  for (const file of workflowFiles) {
    const raw = readFileSync(file, "utf8");
    const relative = makeRelative(options.root, file);
    checkForbiddenRunnerRegistration(raw, relative, violations);
    checkCacheAssignments(raw, relative, violations);
    checkActionsCachePaths(raw, relative, violations);
    checkWorkflowRunsOn(options.root, file, violations);
    checkExplicitCheckoutClean(raw, relative, violations);
  }

  for (const file of actionFiles) {
    const raw = readFileSync(file, "utf8");
    const relative = makeRelative(options.root, file);
    checkForbiddenRunnerRegistration(raw, relative, violations);
    checkCacheAssignments(raw, relative, violations);
    checkActionsCachePaths(raw, relative, violations);
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      const prefix = violation.line ? `${violation.file}:${violation.line}` : violation.file;
      console.error(`${prefix}: ${violation.message}`);
    }
    console.error(`workflow runner governance failed: ${violations.length} violation(s)`);
    process.exit(1);
  }

  console.log("workflow runner governance passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { parseArgs };
