import { fail } from "k6";

const DEFAULT_DATASET = {
  public: {
    rumMetric: "web_vitals_lcp",
    rumValue: 1200,
    rumPath: "/register",
    duplicateDetail: "email already registered",
  },
  universal: {
    startUrl: "/register",
    mode: "manual",
    searchLimit: 30,
    sourceEventCount: 4,
    templateNamePrefix: "k6-template",
    flowNamePrefix: "k6-flow",
    runEmailDomain: "example.com",
  },
};

const MERGEABLE_OBJECT_TAG = "[object Object]";

function envFirst(keys, fallbackValue = "") {
  for (const key of keys) {
    const value = (__ENV[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return fallbackValue;
}

function parseBoolean(raw, fallbackValue) {
  if (!raw) {
    return fallbackValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  fail(`invalid boolean value "${raw}"`);
  return fallbackValue;
}

function parseJson(raw, sourceLabel) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`${sourceLabel} is not valid JSON: ${message}`);
    return {};
  }
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === MERGEABLE_OBJECT_TAG;
}

function deepMerge(baseValue, overrideValue) {
  if (Array.isArray(baseValue) || Array.isArray(overrideValue)) {
    return overrideValue;
  }
  if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
    return overrideValue;
  }
  const merged = { ...baseValue };
  for (const key of Object.keys(overrideValue)) {
    const baseChild = merged[key];
    const overrideChild = overrideValue[key];
    if (isPlainObject(baseChild) && isPlainObject(overrideChild)) {
      merged[key] = deepMerge(baseChild, overrideChild);
      continue;
    }
    merged[key] = overrideChild;
  }
  return merged;
}

function loadDatasetOverrides() {
  const inlineDataset = (__ENV.DATASET_JSON || "").trim();
  const datasetFile = (__ENV.DATASET_FILE || "").trim();
  if (inlineDataset && datasetFile) {
    fail("choose one data source: DATASET_JSON or DATASET_FILE");
  }
  if (inlineDataset) {
    return parseJson(inlineDataset, "DATASET_JSON");
  }
  if (!datasetFile) {
    return {};
  }
  let raw = "";
  try {
    raw = open(datasetFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`cannot read DATASET_FILE=${datasetFile}: ${message}`);
    return {};
  }
  return parseJson(raw, `DATASET_FILE=${datasetFile}`);
}

function normalizeBaseUrl(rawBaseUrl) {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) {
    fail("BASE_URL/TARGET_URL cannot be empty");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    fail(`BASE_URL/TARGET_URL must start with http:// or https://, got "${rawBaseUrl}"`);
  }
  return trimmed.replace(/\/+$/, "");
}

function appendSuffixToEmail(baseEmail, suffix) {
  const atIndex = baseEmail.indexOf("@");
  if (atIndex <= 0 || atIndex === baseEmail.length - 1) {
    fail(`LOGIN_EMAIL must look like an email address, got "${baseEmail}"`);
  }
  const localPart = baseEmail.slice(0, atIndex);
  const domain = baseEmail.slice(atIndex + 1);
  return `${localPart}+${suffix}@${domain}`;
}

function normalizeDataset(overrides) {
  const merged = deepMerge(DEFAULT_DATASET, overrides);
  if (!isPlainObject(merged.public) || !isPlainObject(merged.universal)) {
    fail("dataset must contain object keys: public and universal");
  }
  return merged;
}

const dataset = normalizeDataset(loadDatasetOverrides());

export function makeIterationSuffix(vu, iter) {
  const now = Date.now();
  const randomTail = Math.floor(Math.random() * 1e6);
  return `${vu}-${iter}-${now}-${randomTail}`;
}

export function buildRuntimeConfig() {
  const baseUrl = normalizeBaseUrl(envFirst(["TARGET_URL", "BASE_URL"], "http://127.0.0.1:17380"));
  const scenario = envFirst(["SCENARIO", "JOURNEY_SCENARIO"], "public_register");
  const loginEmail = envFirst(
    ["LOGIN_EMAIL", "JOURNEY_EMAIL"],
    "k6.user@example.com",
  ).toLowerCase();
  const password = envFirst(["LOGIN_PASSWORD", "JOURNEY_PASSWORD"], "StrongPass1!");
  const automationToken = envFirst(["AUTOMATION_API_TOKEN", "AUTOMATION_API_TOKEN"]);
  if (password.length < 8) {
    fail("LOGIN_PASSWORD/JOURNEY_PASSWORD must be at least 8 chars");
  }
  if (scenario === "universal_automation" && !automationToken) {
    fail("universal_automation scenario requires AUTOMATION_API_TOKEN/AUTOMATION_API_TOKEN");
  }

  return {
    baseUrl,
    scenario,
    dataset,
    credentials: {
      loginEmail,
      password,
      appendUniqueSuffix: parseBoolean((__ENV.APPEND_UNIQUE_SUFFIX || "").trim(), true),
      automationToken,
      automationClientId: envFirst(["AUTOMATION_CLIENT_ID", "X_AUTOMATION_CLIENT_ID"], "k6-load"),
      automationUser: envFirst(["AUTOMATION_USER"], "k6-load-user"),
    },
  };
}

export function buildJourneyEmail(config, suffix) {
  if (!config.credentials.appendUniqueSuffix) {
    return config.credentials.loginEmail;
  }
  return appendSuffixToEmail(config.credentials.loginEmail, suffix);
}

export function resolveJourneyStartUrl(config, configuredUrl) {
  const raw = String(configuredUrl || "").trim();
  if (!raw) {
    return `${config.baseUrl}/register`;
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  const normalizedPath = raw.startsWith("/") ? raw : `/${raw}`;
  return `${config.baseUrl}${normalizedPath}`;
}
