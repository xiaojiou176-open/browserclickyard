import { fail } from "k6";
import { publicRegisterScenario } from "./public-register-journey.js";
import { universalAutomationScenario } from "./universal-automation-journey.js";

const SCENARIO_REGISTRY = {
  public_register: publicRegisterScenario,
  universal_automation: universalAutomationScenario,
};

export function resolveScenario(name) {
  const normalized = String(name || "").trim();
  const scenario = SCENARIO_REGISTRY[normalized];
  if (!scenario) {
    fail(
      `unknown SCENARIO/JOURNEY_SCENARIO "${name}". supported: ${Object.keys(SCENARIO_REGISTRY).join(", ")}`,
    );
  }
  return scenario;
}
