import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import YAML from "../../../../scripts/lib/yaml-loader.mjs";

export function loadYamlFileUnderRoot<T>(rootDir: string, relPath: string): T {
  if (isAbsolute(relPath)) {
    throw new Error(`Path '${relPath}' must be relative`);
  }

  const rootPath = realpathSync(resolve(rootDir));
  const candidateAbs = resolve(rootPath, relPath);
  const filePath = realpathSync(candidateAbs);
  const relToRoot = relative(rootPath, filePath);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
    throw new Error(`Path '${relPath}' escapes root '${rootPath}'`);
  }

  const raw = readFileSync(filePath, "utf8");
  return YAML.parse(raw) as T;
}

function resolveYamlPath(pathFromRepoRoot: string): string {
  const normalized = pathFromRepoRoot.trim();
  if (!normalized) {
    throw new Error("YAML path must not be empty");
  }

  const repoRootReal = realpathSync(resolve("."));
  const candidateAbs = resolve(repoRootReal, normalized);
  const candidateReal = realpathSync(candidateAbs);
  const rel = relative(repoRootReal, candidateReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal blocked for YAML: ${pathFromRepoRoot}`);
  }

  return candidateReal;
}

export function loadYamlFile<T>(pathFromRepoRoot: string): T {
  const filePath = resolveYamlPath(pathFromRepoRoot);
  const raw = readFileSync(filePath, "utf8");
  return YAML.parse(raw) as T;
}
