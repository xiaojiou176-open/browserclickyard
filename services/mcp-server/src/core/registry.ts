const OPTIONAL_TOOL_GROUPS = ["advanced", "register", "proof", "analysis"] as const;

type OptionalToolGroup = (typeof OPTIONAL_TOOL_GROUPS)[number];

export type ToolGroup = "core" | OptionalToolGroup;

export const CORE_12_TOOL_NAMES = [
  "uiq_backend_runtime",
  "uiq_api_sessions",
  "uiq_api_flows",
  "uiq_api_templates",
  "uiq_api_runs",
  "uiq_catalog",
  "uiq_server_selfcheck",
  "uiq_run_profile",
  "uiq_run_stream",
  "uiq_run_overview",
  "uiq_read_artifact",
  "uiq_gate_failures",
] as const;

export const ADVANCED_TOOL_NAMES = [
  "uiq_api_automation_commands",
  "uiq_api_automation_tasks",
  "uiq_api_automation_task",
  "uiq_api_automation_run",
  "uiq_api_automation_cancel",
  "uiq_run_command",
  "uiq_computer_use_run",
  "uiq_read_manifest",
  "uiq_list_runs",
  "uiq_read_repo_doc",
  "uiq_summarize_failures",
] as const;

export const REGISTER_TOOL_NAMES = ["uiq_register_orchestrate", "uiq_register_state"] as const;

export const PROOF_TOOL_NAMES = [
  "uiq_model_target_capabilities",
  "uiq_run_proof_campaign",
  "uiq_read_proof_report",
  "uiq_export_proof_bundle",
  "uiq_diff_proof_campaign",
  "uiq_read_run_ai_review",
  "uiq_generate_release_brief",
  "uiq_find_similar_failures",
  "uiq_explain_template_feasibility",
  "uiq_list_manual_gates",
] as const;

export const ANALYSIS_TOOL_NAMES = [
  "uiq_a11y_top",
  "uiq_perf_metrics",
  "uiq_visual_status",
  "uiq_security_summary",
  "uiq_compare_perf",
] as const;

export const TOOL_NAMES_BY_GROUP: Record<ToolGroup, readonly string[]> = {
  core: CORE_12_TOOL_NAMES,
  advanced: ADVANCED_TOOL_NAMES,
  register: REGISTER_TOOL_NAMES,
  proof: PROOF_TOOL_NAMES,
  analysis: ANALYSIS_TOOL_NAMES,
};

export const ALL_REGISTERED_TOOL_NAMES = Array.from(
  new Set(Object.values(TOOL_NAMES_BY_GROUP).flatMap((toolNames) => Array.from(toolNames))),
).sort();

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isOptionalToolGroup(value: string): value is OptionalToolGroup {
  return (OPTIONAL_TOOL_GROUPS as readonly string[]).includes(value);
}

function parseGroups(input: string | undefined): Set<OptionalToolGroup> {
  if (!input) {
    return new Set();
  }

  const tokens = input.split(",").map((item) => item.trim().toLowerCase());
  const groups = new Set<OptionalToolGroup>();

  for (const token of tokens) {
    if (token === "all") {
      for (const group of OPTIONAL_TOOL_GROUPS) {
        groups.add(group);
      }
      continue;
    }
    if (isOptionalToolGroup(token)) {
      groups.add(token);
    }
  }

  return groups;
}

export function resolveEnabledToolGroups(env: NodeJS.ProcessEnv = process.env): Set<ToolGroup> {
  const enabled = new Set<ToolGroup>(["core"]);
  const explicitGroups = parseGroups(env.UIQ_MCP_TOOL_GROUPS);

  for (const group of explicitGroups) {
    enabled.add(group);
  }

  const legacyExposeAdvanced =
    parseBooleanEnv(env.UIQ_MCP_EXPOSE_ADVANCED_TOOLS) ||
    parseBooleanEnv(env.UIQ_MCP_EXPOSE_ADVANCED);
  const legacyEnableAdvanced = parseBooleanEnv(env.UIQ_MCP_ENABLE_ADVANCED_TOOLS);

  if (legacyExposeAdvanced || legacyEnableAdvanced) {
    for (const group of OPTIONAL_TOOL_GROUPS) {
      enabled.add(group);
    }
  }

  return enabled;
}

export function isToolEnabled(toolName: string, enabledGroups: Set<ToolGroup>): boolean {
  for (const group of enabledGroups) {
    if (TOOL_NAMES_BY_GROUP[group].includes(toolName)) {
      return true;
    }
  }
  return false;
}
