#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function runGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasGhAuthSession() {
  try {
    execFileSync("gh", ["auth", "status"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function extractRepoSlugFromOrigin() {
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (remoteUrl.startsWith("https://github.com/")) {
      return remoteUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    }
    if (remoteUrl.startsWith("git@github.com:")) {
      return remoteUrl.replace(/^git@github\.com:/, "").replace(/\.git$/, "");
    }
    const sshAliasMatch = remoteUrl.match(/^git@github\.com-[^:]+:(.+?)(?:\.git)?$/);
    if (sshAliasMatch) {
      return sshAliasMatch[1];
    }
  } catch {
    // Fall through.
  }
  return "";
}

function parseArgs(argv) {
  const options = {
    repo: process.env.GITHUB_REPOSITORY || extractRepoSlugFromOrigin(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--repo" && next) {
      options.repo = next;
      index += 1;
    }
  }

  return options;
}

function fetchPagedAlerts(endpoint) {
  const output = runGh(["api", "--paginate", "--slurp", endpoint]);
  const pages = JSON.parse(output);
  if (!Array.isArray(pages)) {
    return [];
  }
  return pages.flatMap((page) => (Array.isArray(page) ? page : []));
}

function summarizeAlerts(alerts) {
  return alerts.map((alert) => {
    const number = alert.number ?? "unknown";
    const state = alert.state ?? "unknown";
    const htmlUrl = alert.html_url ?? "";
    const rule =
      alert.rule?.id ?? alert.rule?.description ?? alert.secret_type_display_name ?? alert.secret_type ?? "unknown";
    return `#${number} state=${state} rule=${rule}${htmlUrl ? ` url=${htmlUrl}` : ""}`;
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.repo) {
    console.error("[check-github-security-alerts] FAIL");
    console.error("- missing repository slug; pass --repo <owner/name> or configure origin");
    process.exit(1);
  }

  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !hasGhAuthSession()) {
    console.error("[check-github-security-alerts] FAIL");
    console.error("- missing GH authentication session");
    process.exit(1);
  }

  const failures = [];

  try {
    const secretAlerts = fetchPagedAlerts(
      `repos/${options.repo}/secret-scanning/alerts?state=open&per_page=100`,
    );
    if (secretAlerts.length > 0) {
      failures.push(
        ...summarizeAlerts(secretAlerts).map(
          (summary) => `secret-scanning open alert: ${summary}`,
        ),
      );
    }
  } catch (error) {
    failures.push(
      `secret-scanning check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const codeAlerts = fetchPagedAlerts(
      `repos/${options.repo}/code-scanning/alerts?state=open&per_page=100`,
    );
    if (codeAlerts.length > 0) {
      failures.push(
        ...summarizeAlerts(codeAlerts).map(
          (summary) => `code-scanning open alert: ${summary}`,
        ),
      );
    }
  } catch (error) {
    failures.push(
      `code-scanning check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const dependabotAlerts = fetchPagedAlerts(
      `repos/${options.repo}/dependabot/alerts?state=open&per_page=100`,
    );
    if (dependabotAlerts.length > 0) {
      failures.push(
        ...summarizeAlerts(dependabotAlerts).map(
          (summary) => `dependabot open alert: ${summary}`,
        ),
      );
    }
  } catch (error) {
    failures.push(
      `dependabot check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (failures.length > 0) {
    console.error("[check-github-security-alerts] FAIL");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`[check-github-security-alerts] PASS repo=${options.repo}`);
}

main();
