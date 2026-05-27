#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();

const files = {
  pyproject: readFileSync(resolve(repoRoot, "pyproject.toml"), "utf8"),
  backendDockerfile: readFileSync(resolve(repoRoot, "services/api/Dockerfile"), "utf8"),
  ciBaseDockerfile: readFileSync(resolve(repoRoot, "docker/ci/base.Dockerfile"), "utf8"),
  setupPythonSmart: readFileSync(
    resolve(repoRoot, ".github/actions/setup-python-smart/action.yml"),
    "utf8",
  ),
  readme: readFileSync(resolve(repoRoot, "README.md"), "utf8"),
};

const failures = [];

if (!files.pyproject.includes('requires-python = ">=3.12"')) {
  failures.push('pyproject.toml must declare requires-python = ">=3.12"');
}
if (!files.pyproject.includes('target-version = "py312"')) {
  failures.push('pyproject.toml must declare Ruff target-version = "py312"');
}
if (!files.backendDockerfile.includes("FROM python:3.12-slim-bookworm")) {
  failures.push("services/api/Dockerfile must use python:3.12-slim-bookworm");
}
if (!files.ciBaseDockerfile.includes("FROM python:3.12-slim-bookworm")) {
  failures.push("docker/ci/base.Dockerfile must use python:3.12-slim-bookworm");
}
if (!files.setupPythonSmart.includes('default: "3.12"')) {
  failures.push('.github/actions/setup-python-smart/action.yml must default to Python 3.12');
}
if (!files.readme.includes("Python = 3.12.x")) {
  failures.push("README.md must document Python 3.12 baseline");
}

for (const [name, content] of Object.entries(files)) {
  if (/3\.11|py311|python:3\.11/i.test(content)) {
    failures.push(`${name} still contains active Python 3.11 baseline markers`);
  }
}

if (failures.length > 0) {
  console.error(`[check-python-baseline] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-python-baseline] PASS");
