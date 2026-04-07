import { isAbsolute } from "node:path";
import { loadYamlFile } from "../../../../core/src/config/loadYaml.js";
import { assertBaseUrlAllowed as assertBaseUrlAllowedShared } from "./config.js";
import { CONFIG_NAME_PATTERN } from "./run-schema.js";
import type { BaseUrlPolicyResult, ProfileConfig, TargetConfig } from "./run-types.js";
import { validateProfileConfig, validateTargetConfig } from "./run-validate.js";

function sanitizeConfigName(kind: "profile" | "target", input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error(`Invalid ${kind}: empty value`);
  }
  if (isAbsolute(normalized)) {
    throw new Error(`Invalid ${kind}: absolute path is not allowed`);
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error(`Invalid ${kind}: path separators or '..' are not allowed`);
  }
  if (!CONFIG_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${kind}: only [A-Za-z0-9._-] allowed`);
  }
  return normalized;
}

export function loadProfileConfig(profileName: string): ProfileConfig {
  const safeProfileName = sanitizeConfigName("profile", profileName);
  const loaded = loadYamlFile<ProfileConfig>(`configs/profiles/${safeProfileName}.yaml`);
  return validateProfileConfig(loaded, safeProfileName);
}

export function loadTargetConfig(targetName: string): TargetConfig {
  const safeTargetName = sanitizeConfigName("target", targetName);
  const loaded = loadYamlFile<TargetConfig>(`configs/targets/${safeTargetName}.yaml`);
  return validateTargetConfig(loaded, safeTargetName);
}

export function assertBaseUrlAllowed(
  target: TargetConfig,
  baseUrl: string,
  allowAllUrls = false,
): BaseUrlPolicyResult {
  return assertBaseUrlAllowedShared(
    target as unknown as Parameters<typeof assertBaseUrlAllowedShared>[0],
    baseUrl,
    allowAllUrls,
  ) as unknown as BaseUrlPolicyResult;
}
