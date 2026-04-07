#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_VERSION = "1.42.0";

const files = {
  pyproject: path.join(ROOT, "pyproject.toml"),
  requirements: path.join(ROOT, "scripts/computer-use/requirements.txt"),
  uvLock: path.join(ROOT, "uv.lock"),
  packageJson: path.join(ROOT, "tooling/automation/package.json"),
  pnpmLock: path.join(ROOT, "pnpm-lock.yaml"),
};

const read = (file) => fs.readFileSync(file, "utf8");

const errors = [];

const pyprojectText = read(files.pyproject);
const pyprojectMatch = pyprojectText.match(/"google-genai([^"]*)"/);
if (!pyprojectMatch) {
  errors.push("pyproject.toml is missing the google-genai declaration");
} else {
  const spec = pyprojectMatch[1];
  if (spec !== `==${TARGET_VERSION}`) {
    errors.push(
      `pyproject.toml expected google-genai==${TARGET_VERSION}, found google-genai${spec}`,
    );
  }
}

const requirementsText = read(files.requirements);
const requirementsMatch = requirementsText.match(/^google-genai([^\s#]*)/m);
if (!requirementsMatch) {
  errors.push("scripts/computer-use/requirements.txt is missing the google-genai declaration");
} else {
  const spec = requirementsMatch[1];
  if (spec !== `==${TARGET_VERSION}`) {
    errors.push(
      `requirements.txt expected google-genai==${TARGET_VERSION}, found google-genai${spec}`,
    );
  }
}

const uvLockText = read(files.uvLock);
const uvSpecifierMatch = uvLockText.match(
  /\{ name = "google-genai", marker = "extra == 'dev'", specifier = "([^"]+)" \}/,
);
if (!uvSpecifierMatch) {
  errors.push("uv.lock is missing the google-genai dev specifier record");
} else {
  const uvSpecifier = uvSpecifierMatch[1];
  if (uvSpecifier !== `==${TARGET_VERSION}`) {
    errors.push(`uv.lock specifier expected ==${TARGET_VERSION}, found ${uvSpecifier}`);
  }
}

const uvVersionMatch = uvLockText.match(
  /\[\[package\]\]\nname = "google-genai"\nversion = "([^"]+)"/,
);
if (!uvVersionMatch) {
  errors.push("uv.lock is missing the google-genai locked version");
} else {
  const uvVersion = uvVersionMatch[1];
  if (uvVersion !== TARGET_VERSION) {
    errors.push(`uv.lock locked version expected ${TARGET_VERSION}, found ${uvVersion}`);
  }
}

const packageJson = JSON.parse(read(files.packageJson));
const nodeSpec = packageJson?.devDependencies?.["@google/genai"];
if (!nodeSpec) {
  errors.push("tooling/automation/package.json is missing devDependencies.@google/genai");
} else if (nodeSpec !== TARGET_VERSION) {
  errors.push(
    `tooling/automation/package.json expected @google/genai=${TARGET_VERSION}, found ${nodeSpec}`,
  );
}

const pnpmLockText = read(files.pnpmLock);
const importerBlockMatch = pnpmLockText.match(
  /\n\s{2}tooling\/automation:\s*\n([\s\S]*?)(?:\n\s{2}[A-Za-z0-9_./-]+:\s*\n|\npackages:\s*\n)/m,
);
if (!importerBlockMatch) {
  errors.push("pnpm-lock.yaml is missing the automation importer block");
} else {
  const importerBlock = importerBlockMatch[1];
  const importerMatch = importerBlock.match(/'@google\/genai':\n\s+specifier:\s+([^\n]+)\n\s+version:\s+([^\n]+)/m);
  if (!importerMatch) {
    errors.push("pnpm-lock.yaml is missing the automation importer's @google/genai entry");
  } else {
    const lockSpecifier = importerMatch[1].trim();
    const lockVersion = importerMatch[2].trim();
  if (lockSpecifier !== TARGET_VERSION) {
    errors.push(
      `pnpm-lock.yaml automation importer specifier expected ${TARGET_VERSION}, found ${lockSpecifier}`,
    );
  }
  if (!lockVersion.startsWith(`${TARGET_VERSION}`)) {
    errors.push(
      `pnpm-lock.yaml automation importer version expected to start with ${TARGET_VERSION}, found ${lockVersion}`,
    );
  }
  }
}

if (errors.length > 0) {
  console.error(`[check-gemini-sdk-versions] FAIL (${errors.length} issue(s))`);
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log("[check-gemini-sdk-versions] PASS");
