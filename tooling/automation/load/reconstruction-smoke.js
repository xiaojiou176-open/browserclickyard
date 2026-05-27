import { fail } from "k6";
import { buildRuntimeConfig } from "./scenario-lib/config.js";
import { resolveScenario } from "./scenarios/index.js";

export const options = {
  vus: parsePositiveInt("VUS", 1),
  iterations: parsePositiveInt("ITERATIONS", 1),
  thresholds: {
    checks: ["rate==1.0"],
    http_req_failed: ["rate==0"],
  },
};

const runtimeConfig = buildRuntimeConfig();
const scenario = resolveScenario(runtimeConfig.scenario);

function parsePositiveInt(name, fallbackValue) {
  const raw = (__ENV[name] || "").trim();
  if (!raw) {
    return fallbackValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export default function () {
  scenario.execute({
    config: runtimeConfig,
    vu: __VU,
    iter: __ITER,
  });
}
