const UIQ_ALL_COMMANDS = Object.freeze([
  "run",
  "capture",
  "explore",
  "chaos",
  "a11y",
  "perf",
  "visual",
  "unit",
  "ct",
  "e2e",
  "load",
  "security",
  "desktop-readiness",
  "desktop-smoke",
  "desktop-e2e",
  "desktop-soak",
  "report",
]);

const UIQ_PROOF_DIMENSIONS = Object.freeze([
  "gate",
  "a11y",
  "perf",
  "visual",
  "security",
  "load",
  "explore",
  "chaos",
  "desktopReadiness",
  "desktopSmoke",
  "desktopE2E",
  "desktopSoak",
]);

const WEB_TARGET = Object.freeze({
  commands: Object.freeze([
    "run",
    "capture",
    "explore",
    "chaos",
    "a11y",
    "perf",
    "visual",
    "unit",
    "ct",
    "e2e",
    "load",
    "security",
    "report",
  ]),
  expectedArtifacts: Object.freeze([
    "reports/summary.json",
    "a11y/axe.json",
    "perf/lighthouse.json",
    "visual/report.json",
    "security/report.json",
    "metrics/load-summary.json",
    "explore/report.json",
    "chaos/report.json",
  ]),
});

const DESKTOP_TARGET = Object.freeze({
  commands: Object.freeze([
    "run",
    "desktop-readiness",
    "desktop-smoke",
    "desktop-e2e",
    "desktop-soak",
    "report",
  ]),
  expectedArtifacts: Object.freeze([
    "reports/summary.json",
    "metrics/desktop-readiness.json",
    "metrics/desktop-smoke.json",
    "metrics/desktop-e2e.json",
    "metrics/desktop-soak.json",
  ]),
});

const UIQ_TARGET_CAPABILITY_CATALOG = Object.freeze({
  web: WEB_TARGET,
  tauri: DESKTOP_TARGET,
  swift: DESKTOP_TARGET,
});

export function buildModelTargetCapabilities(model: string): {
  model: string;
  proofDimensions: string[];
  targets: Record<string, { commands: string[]; expectedArtifacts: string[] }>;
} {
  return {
    model,
    proofDimensions: [...UIQ_PROOF_DIMENSIONS],
    targets: {
      web: {
        commands: [...UIQ_TARGET_CAPABILITY_CATALOG.web.commands],
        expectedArtifacts: [...UIQ_TARGET_CAPABILITY_CATALOG.web.expectedArtifacts],
      },
      tauri: {
        commands: [...UIQ_TARGET_CAPABILITY_CATALOG.tauri.commands],
        expectedArtifacts: [...UIQ_TARGET_CAPABILITY_CATALOG.tauri.expectedArtifacts],
      },
      swift: {
        commands: [...UIQ_TARGET_CAPABILITY_CATALOG.swift.commands],
        expectedArtifacts: [...UIQ_TARGET_CAPABILITY_CATALOG.swift.expectedArtifacts],
      },
    },
  };
}
