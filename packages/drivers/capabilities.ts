import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type DriverCapability =
  | "navigate"
  | "interact"
  | "capture"
  | "logs"
  | "network"
  | "trace"
  | "lifecycle";

export type DriverCapabilitySet = Record<DriverCapability, boolean>;

export type DriverCapabilityContract = {
  driverId: string;
  targetTypes: Array<"web" | "tauri" | "swift">;
  capabilities: DriverCapabilitySet;
  notes?: string[];
};

const NO_CAPABILITIES: DriverCapabilitySet = {
  navigate: false,
  interact: false,
  capture: false,
  logs: false,
  network: false,
  trace: false,
  lifecycle: false,
};

const DRIVER_CAPABILITY_REGISTRY_FILE =
  process.env.UIQ_DRIVER_CAPABILITIES_REGISTRY_FILE?.trim() ||
  "configs/drivers/capabilities.registry.json";

const TEST_FALLBACK_DRIVER_CAPABILITY_MAP: Record<string, DriverCapabilityContract> = {
  "web-playwright": {
    driverId: "web-playwright",
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
    driverId: "tauri-webdriver",
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
    driverId: "macos-xcuitest",
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

function parseListFromEnv(raw: string | undefined): string[] | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      const fromJson = parsed.map((value) => value.trim()).filter((value) => value.length > 0);
      return fromJson.length > 0 ? fromJson : null;
    }
  } catch {
    // fallback to comma-separated values
  }
  const fromCsv = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return fromCsv.length > 0 ? fromCsv : null;
}

function sanitizeTargetTypes(raw: unknown): Array<"web" | "tauri" | "swift"> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const filtered = raw.filter(
    (item): item is "web" | "tauri" | "swift" =>
      item === "web" || item === "tauri" || item === "swift",
  );
  return [...new Set(filtered)];
}

function sanitizeCapabilitySet(raw: unknown): DriverCapabilitySet {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<DriverCapabilitySet>;
  return {
    navigate: value.navigate === true,
    interact: value.interact === true,
    capture: value.capture === true,
    logs: value.logs === true,
    network: value.network === true,
    trace: value.trace === true,
    lifecycle: value.lifecycle === true,
  };
}

function sanitizeCapabilityContract(
  raw: unknown,
  fallbackDriverId: string,
): DriverCapabilityContract | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<DriverCapabilityContract>;
  const driverId =
    typeof value.driverId === "string" && value.driverId.trim().length > 0
      ? value.driverId
      : fallbackDriverId;
  const targetTypes = sanitizeTargetTypes(value.targetTypes);
  const capabilities = sanitizeCapabilitySet(value.capabilities);
  if (targetTypes.length === 0) {
    return null;
  }
  return {
    driverId,
    targetTypes,
    capabilities,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

function parseRegistryPayload(raw: unknown): Record<string, DriverCapabilityContract> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { drivers?: unknown }).drivers
      ? (raw as { drivers: unknown }).drivers
      : raw;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const contracts: Record<string, DriverCapabilityContract> = {};
  for (const [driverId, contractRaw] of Object.entries(source)) {
    const contract = sanitizeCapabilityContract(contractRaw, driverId);
    if (contract) {
      contracts[driverId] = contract;
    }
  }
  return contracts;
}

function allowCapabilityFallback(): boolean {
  if (process.env.UIQ_DRIVER_CAPABILITIES_ALLOW_FALLBACK === "1") {
    return true;
  }
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    typeof process.env.PYTEST_CURRENT_TEST === "string"
  );
}

function loadRegistryFromFile(): Record<string, DriverCapabilityContract> {
  const absoluteFile = resolve(process.cwd(), DRIVER_CAPABILITY_REGISTRY_FILE);
  if (!existsSync(absoluteFile)) {
    if (allowCapabilityFallback()) {
      return TEST_FALLBACK_DRIVER_CAPABILITY_MAP;
    }
    throw new Error(
      `driver capability registry missing: ${DRIVER_CAPABILITY_REGISTRY_FILE}. ` +
        "Normal runtime must load the registry file. " +
        "Fallback is allowed only for tests or controlled diagnostics.",
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(absoluteFile, "utf8")) as unknown;
    const contracts = parseRegistryPayload(parsed);
    if (Object.keys(contracts).length > 0) {
      return contracts;
    }
    if (allowCapabilityFallback()) {
      return TEST_FALLBACK_DRIVER_CAPABILITY_MAP;
    }
    throw new Error(
      `driver capability registry invalid: ${DRIVER_CAPABILITY_REGISTRY_FILE} produced no contracts`,
    );
  } catch (error) {
    if (allowCapabilityFallback()) {
      return TEST_FALLBACK_DRIVER_CAPABILITY_MAP;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `driver capability registry invalid: ${DRIVER_CAPABILITY_REGISTRY_FILE} (${message})`,
    );
  }
}

function loadRegisteredCapabilityContracts(): Record<string, DriverCapabilityContract> {
  const inlineRegistry = process.env.UIQ_DRIVER_CAPABILITIES_REGISTRY_JSON?.trim();
  if (inlineRegistry && inlineRegistry.length > 0) {
    try {
      const parsed = JSON.parse(inlineRegistry) as unknown;
      const inlineContracts = parseRegistryPayload(parsed);
      if (Object.keys(inlineContracts).length > 0) {
        return inlineContracts;
      }
    } catch {
      // fallback to file/default map
    }
  }
  return loadRegistryFromFile();
}

const DRIVER_CAPABILITY_MAP = loadRegisteredCapabilityContracts();

export function getDriverCapabilityContract(
  driverId: string,
  targetType: string,
): DriverCapabilityContract {
  const mapped = DRIVER_CAPABILITY_MAP[driverId];
  if (!mapped) {
    return {
      driverId,
      targetTypes:
        targetType === "web" || targetType === "tauri" || targetType === "swift"
          ? [targetType]
          : ["web"],
      capabilities: { ...NO_CAPABILITIES },
      notes: ["driver not found in capability contract map"],
    };
  }
  return mapped;
}

const FALLBACK_WEB_ONLY_STEPS = [
  "capture",
  "explore",
  "chaos",
  "a11y",
  "perf",
  "visual",
  "load",
  "computer_use",
];
const FALLBACK_DESKTOP_ONLY_STEPS = [
  "desktop_readiness",
  "desktop_smoke",
  "desktop_e2e",
  "desktop_business_regression",
  "desktop_soak",
];
const WEB_ONLY_STEPS = new Set(
  parseListFromEnv(process.env.UIQ_WEB_ONLY_STEPS) ?? FALLBACK_WEB_ONLY_STEPS,
);
const DESKTOP_ONLY_STEPS = new Set(
  parseListFromEnv(process.env.UIQ_DESKTOP_ONLY_STEPS) ?? FALLBACK_DESKTOP_ONLY_STEPS,
);

export function isStepSupportedByDriver(
  stepId: string,
  targetType: string,
  contract: DriverCapabilityContract,
): boolean {
  if (WEB_ONLY_STEPS.has(stepId)) {
    return targetType === "web" && contract.capabilities.navigate && contract.capabilities.capture;
  }
  if (DESKTOP_ONLY_STEPS.has(stepId)) {
    return (targetType === "tauri" || targetType === "swift") && contract.capabilities.lifecycle;
  }
  return true;
}
