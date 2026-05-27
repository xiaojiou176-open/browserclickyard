// @ts-nocheck
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "./lib/yaml-loader.mjs";

type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
};

function listApiFiles(root: string): string[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(".py"))
    .map((name) => resolve(root, name))
    .filter((fullPath) => statSync(fullPath).isFile());
}

function collectRouterPrefixes(apiFiles: string[]): Set<string> {
  const prefixes = new Set<string>();
  const prefixPattern = /APIRouter\(\s*prefix\s*=\s*["']([^"']+)["']/g;
  for (const filePath of apiFiles) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(prefixPattern)) {
      const prefix = match[1]?.trim();
      if (!prefix) {
        continue;
      }
      if (prefix.startsWith("/api/") || prefix.startsWith("/health")) {
        prefixes.add(prefix);
      }
    }
  }
  return prefixes;
}

function loadOpenApi(pathToSpec: string): OpenApiSpec {
  return YAML.parse(readFileSync(pathToSpec, "utf8")) as OpenApiSpec;
}

function collectOpenApiOps(spec: OpenApiSpec): Map<string, Set<string>> {
  const ops = new Map<string, Set<string>>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const methodSet = new Set<string>();
    for (const method of Object.keys(methods ?? {})) {
      methodSet.add(method.toUpperCase());
    }
    ops.set(path, methodSet);
  }
  return ops;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery.trim();
}

function collectDocEndpoints(docPath: string): Array<{ method: string; path: string }> {
  const endpoints: Array<{ method: string; path: string }> = [];
  const source = readFileSync(docPath, "utf8");
  const linePattern = /^-\s+`([A-Z]+)\s+([^`]+)`\s*$/gm;
  for (const match of source.matchAll(linePattern)) {
    const method = match[1]?.toUpperCase();
    const path = normalizePath(match[2] ?? "");
    if (!method || !path.startsWith("/")) {
      continue;
    }
    endpoints.push({ method, path });
  }
  return endpoints;
}

function main(): void {
  const root = resolve(".");
  const apiDir = resolve(root, "services/api/app/api");
  const openapiPath = resolve(root, "contracts/openapi/api.yaml");
  const docPath = resolve(root, "docs/reference/universal-api.md");

  const apiFiles = listApiFiles(apiDir);
  const prefixes = collectRouterPrefixes(apiFiles);
  const spec = loadOpenApi(openapiPath);
  const operations = collectOpenApiOps(spec);
  const docEndpoints = collectDocEndpoints(docPath);

  const openapiPaths = [...operations.keys()];
  const missingPrefixes = [...prefixes].filter(
    (prefix) => !openapiPaths.some((path) => path === prefix || path.startsWith(`${prefix}/`)),
  );
  const missingDocEndpoints = docEndpoints.filter(({ method, path }) => {
    const methods = operations.get(path);
    return !methods || !methods.has(method);
  });

  if (missingPrefixes.length > 0 || missingDocEndpoints.length > 0) {
    if (missingPrefixes.length > 0) {
      for (const _prefix of missingPrefixes) {
      }
    }
    if (missingDocEndpoints.length > 0) {
      for (const _item of missingDocEndpoints) {
      }
    }
    process.exit(1);
  }
}

main();
