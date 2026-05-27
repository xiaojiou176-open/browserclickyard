import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const architecturePath = resolve("docs/architecture.md");
const registryPath = resolve("configs/drivers/capabilities.registry.json");

const architecture = readFileSync(architecturePath, "utf8");
const registryRaw = readFileSync(registryPath, "utf8");
const registry = JSON.parse(registryRaw);

const failures = [];

if (!architecture.includes("configs/drivers/capabilities.registry.json")) {
  failures.push("docs/architecture.md must declare configs/drivers/capabilities.registry.json as the driver capability SSOT");
}

const drivers = registry?.drivers;
if (!drivers || typeof drivers !== "object" || Array.isArray(drivers)) {
  failures.push("configs/drivers/capabilities.registry.json must expose a top-level 'drivers' object");
}

const requiredDrivers = {
  "web-playwright": {
    targetTypes: ["web"],
    capabilities: {
      navigate: true,
      interact: true,
      capture: true,
      logs: true,
      network: true,
      trace: true,
      lifecycle: false,
    },
  },
  "tauri-webdriver": {
    targetTypes: ["tauri"],
    capabilities: {
      navigate: true,
      interact: true,
      capture: true,
      logs: true,
      network: false,
      trace: false,
      lifecycle: true,
    },
  },
  "macos-xcuitest": {
    targetTypes: ["swift"],
    capabilities: {
      navigate: false,
      interact: true,
      capture: true,
      logs: true,
      network: false,
      trace: false,
      lifecycle: true,
    },
  },
};

for (const [driverId, expected] of Object.entries(requiredDrivers)) {
  const actual = drivers?.[driverId];
  if (!actual || typeof actual !== "object") {
    failures.push(`driver registry missing entry: ${driverId}`);
    continue;
  }

  const actualTargetTypes = Array.isArray(actual.targetTypes) ? actual.targetTypes : [];
  if (JSON.stringify(actualTargetTypes) !== JSON.stringify(expected.targetTypes)) {
    failures.push(
      `${driverId}.targetTypes mismatch: expected ${JSON.stringify(expected.targetTypes)}, got ${JSON.stringify(actualTargetTypes)}`,
    );
  }

  const actualCapabilities = actual.capabilities;
  for (const [capability, expectedValue] of Object.entries(expected.capabilities)) {
    if (actualCapabilities?.[capability] !== expectedValue) {
      failures.push(
        `${driverId}.capabilities.${capability} mismatch: expected ${String(expectedValue)}, got ${String(actualCapabilities?.[capability])}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`[check-driver-capability-registry-sync] FAIL (${failures.length} issue(s))`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[check-driver-capability-registry-sync] PASS");
