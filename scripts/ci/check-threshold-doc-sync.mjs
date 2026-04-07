#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const THRESHOLD_KEYS = [
  "consoleErrorMax",
  "pageErrorMax",
  "http5xxMax",
  "contractStatus",
  "dangerousActionHitsMax",
  "securityHighVulnMax",
  "a11ySeriousMax",
  "perfLcpMsMax",
  "perfFcpMsMax",
  "visualDiffPixelsMax",
  "loadFailedRequestsMax",
  "loadP95MsMax",
  "loadRpsMin",
];
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function shGit(args) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] })
    .toString("utf8")
    .trim();
}

function tryShGit(args) {
  try {
    return shGit(args);
  } catch {
    return "";
  }
}

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  try {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // ignore summary rendering failures
  }
}

function resolveBaseRef() {
  const raw = (process.env.GITHUB_BASE_REF ?? "").trim();
  if (!raw) {
    return "main";
  }
  if (!SAFE_GIT_REF.test(raw)) {
    process.stderr.write("[threshold-doc-sync] WARN: invalid GITHUB_BASE_REF, fallback to main\n");
    return "main";
  }
  return raw;
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    process.exit(0);
  }

  const baseRef = resolveBaseRef();
  const baseRemoteRef = `origin/${baseRef}`;
  tryShGit(["fetch", "--no-tags", "--depth=200", "origin", baseRef]);

  let diffRange = `${baseRemoteRef}..HEAD`;
  const mergeBase = tryShGit(["merge-base", baseRemoteRef, "HEAD"]);
  if (mergeBase) {
    diffRange = `${mergeBase}..HEAD`;
  }

  const changedFiles = tryShGit(["diff", "--name-only", diffRange])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const profileFilesChanged = changedFiles.some(
    (file) => file.startsWith("configs/profiles/") && file.endsWith(".yaml"),
  );
  if (!profileFilesChanged) {
    appendSummary([
      "### Threshold Governance",
      "- Status: pass",
      "- Detail: No `configs/profiles/*.yaml` changes detected.",
    ]);
    process.exit(0);
  }

  const profileDiff = tryShGit(["diff", "--unified=0", diffRange, "--", "configs/profiles/*.yaml"]);
  const thresholdChanged = profileDiff
    .split("\n")
    .filter((line) => /^[+-](?![+-])/.test(line))
    .some((line) => THRESHOLD_KEYS.some((key) => line.includes(`${key}:`)));

  if (!thresholdChanged) {
    appendSummary([
      "### Threshold Governance",
      "- Status: pass",
      "- Detail: Profile changes detected but no gate-threshold key updates.",
    ]);
    process.exit(0);
  }

  const docsTouched = changedFiles.includes("docs/reference/ci-governance.md");
  if (!docsTouched) {
    appendSummary([
      "### Threshold Governance",
      "- Status: fail",
      "- Detail: Gate threshold keys changed in `configs/profiles/*.yaml` but generated `docs/reference/ci-governance.md` was not updated.",
    ]);
    process.exit(2);
  }
  appendSummary([
    "### Threshold Governance",
    "- Status: pass",
    "- Detail: Threshold keys changed and generated `docs/reference/ci-governance.md` was updated.",
  ]);
}

main();
