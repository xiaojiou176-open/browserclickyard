import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const candidateSpecs = ["yaml"];

function resolvePnpmStoreYamlCandidate(sharedNodeModulesDir) {
  const storeDir = join(sharedNodeModulesDir, ".pnpm");
  if (!existsSync(storeDir)) {
    return undefined;
  }

  const candidates = readdirSync(storeDir)
    .filter((entry) => entry.startsWith("yaml@"))
    .map((entry) => join(storeDir, entry, "node_modules", "yaml"))
    .filter((candidate) => existsSync(candidate))
    .sort();

  return candidates.at(-1);
}

if (process.env.UIQ_NODE_MODULES_DIR) {
  candidateSpecs.push(join(process.env.UIQ_NODE_MODULES_DIR, "yaml"));
  const pnpmStoreCandidate = resolvePnpmStoreYamlCandidate(process.env.UIQ_NODE_MODULES_DIR);
  if (pnpmStoreCandidate) {
    candidateSpecs.push(pnpmStoreCandidate);
  }
}

let YAML;
let lastError;
for (const candidate of candidateSpecs) {
  try {
    if (candidate !== "yaml" && !existsSync(candidate)) {
      continue;
    }
    YAML = require(candidate);
    break;
  } catch (error) {
    lastError = error;
  }
}

if (!YAML) {
  throw lastError ?? new Error("Unable to resolve yaml runtime dependency");
}

export default YAML;
