// @ts-nocheck
// 
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { apiRequest, backendBaseUrl, backendToken } from "../../core/api-client.js";
import {
  buildModelTargetCapabilities,
} from "../../core/model-target-capabilities.js";
import {
  ensureDirReady,
  readUtf8,
  repoRoot,
  runsRoot,
  safeResolveUnder,
  workspaceRoot,
  writeAudit,
} from "../../core/constants.js";
import {
  classifyGovernedToolError,
  classifyRunFailureReasonCode,
  governedErrorResponse,
  withGovernedExecution,
} from "../../core/governance.js";
import { proofCampaignsRoot, writeJson } from "../../core/io.js";
import { redactSensitiveText, sanitizeProfileTarget, sanitizeRunId } from "../../core/redaction.js";
import { type RunOverrideValues, runOverrideSchema } from "../../core/types.js";
import { RUN_TOOL_DESCRIPTIONS } from "./descriptions.js";
import {
  analyzeA11y,
  analyzePerf,
  analyzeSecurity,
  analyzeVisual,
  appendRunOverrides,
  desktopInputWarnings,
  latestRunId,
  listRunIds,
  listYamlStemNames,
  pickRunIdOrLatest,
  readRepoTextFile,
  readRunOverview,
  runUiqStream,
  runUiqSync,
} from "./shared.js";

type RunToolRegistrationOptions = {
  enableAdvanced?: boolean;
  enableAnalysis?: boolean;
  enableProof?: boolean;
};

async function proofApiGet(path: string): Promise<unknown> {
  const response = await apiRequest(path);
  if (!response.ok) {
    throw new Error(typeof response.body === "string" ? response.body : `request failed: ${response.status}`);
  }
  return response.json ?? response.body;
}

async function proofApiPost(path: string, body: unknown): Promise<unknown> {
  const response = await apiRequest(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(typeof response.body === "string" ? response.body : `request failed: ${response.status}`);
  }
  return response.json ?? response.body;
}

async function withProofGuard(tool: Parameters<typeof withGovernedExecution>[0], execute: () => Promise<{ content: Array<{ type: "text"; text: string }> }>) {
  try {
    return await withGovernedExecution(tool, async () => execute());
  } catch (error) {
    const classified = classifyGovernedToolError(tool, error);
    return governedErrorResponse(tool, classified.reasonCode, classified.detail, classified.meta);
  }
}

const GOVERNED_TOOL_UIQ_RUN_COMMAND = "uiq_run_command" as unknown as Parameters<
  typeof withGovernedExecution
>[0];
const GOVERNED_TOOL_UIQ_RUN_STREAM = "uiq_run_stream" as unknown as Parameters<
  typeof withGovernedExecution
>[0];
const GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN = "uiq_computer_use_run" as unknown as Parameters<
  typeof withGovernedExecution
>[0];
const GOVERNED_TOOL_UIQ_READ_ARTIFACT = "uiq_read_artifact" as unknown as Parameters<
  typeof withGovernedExecution
>[0];
const GOVERNED_TOOL_UIQ_READ_REPO_DOC = "uiq_read_repo_doc" as unknown as Parameters<
  typeof withGovernedExecution
>[0];

function executeRunCommand(args: {
  command: string;
  profile?: string;
  target?: string;
  runId?: string;
  extraArgs?: string[];
  overrides?: RunOverrideValues;
  timeoutMs?: number;
}): { result: ReturnType<typeof runUiqSync>; warnings: string[] } {
  const safeTarget = args.target ? sanitizeProfileTarget("target", args.target) : undefined;
  const safeProfile = args.profile ? sanitizeProfileTarget("profile", args.profile) : undefined;
  const safeRunId = args.runId ? sanitizeRunId(args.runId) : undefined;
  const commandArgs = [args.command];
  if (args.extraArgs) {
    commandArgs.push(...args.extraArgs);
  }
  if (safeTarget) {
    commandArgs.push("--target", safeTarget);
  }
  if (safeProfile) {
    commandArgs.push("--profile", safeProfile);
  }
  if (safeRunId) {
    commandArgs.push("--run-id", safeRunId);
  }
  const overrides = args.overrides ?? {};
  appendRunOverrides(commandArgs, overrides);
  return {
    result: runUiqSync(commandArgs, args.timeoutMs),
    warnings: desktopInputWarnings({
      command: args.command,
      profile: safeProfile,
      target: safeTarget,
      app: typeof overrides.app === "string" ? overrides.app : undefined,
      bundleId: typeof overrides.bundleId === "string" ? overrides.bundleId : undefined,
    }),
  };
}

function resolveCatalogYamlDir(kind: "profiles" | "targets"): string {
  const canonicalDir = resolve(workspaceRoot(), "configs", kind);
  const fixtureFallbackDir = resolve(workspaceRoot(), kind);
  const canonicalEntries = listYamlStemNames(canonicalDir);
  if (canonicalEntries.length > 0) {
    return canonicalDir;
  }
  return fixtureFallbackDir;
}

export function registerRunTools(
  mcpServer: McpServer,
  options: RunToolRegistrationOptions = {},
): void {
  const enableAdvanced = options.enableAdvanced === true;
  const enableAnalysis = options.enableAnalysis === true;
  const enableProof = options.enableProof === true;

  mcpServer.registerTool(
    "uiq_catalog",
    { description: "List available configs/profiles, configs/targets, and commands in this repository", inputSchema: {} },
    async () => {
      const profiles = listYamlStemNames(resolveCatalogYamlDir("profiles"));
      const targets = listYamlStemNames(resolveCatalogYamlDir("targets"));
      const commands = [
        "run",
        "capture",
        "explore",
        "chaos",
        "a11y",
        "perf",
        "visual",
        "e2e",
        "load",
        "security",
        "computer-use",
        "desktop-readiness",
        "desktop-e2e",
        "desktop-business",
        "desktop-soak",
        "engines:check",
        "report",
      ];
      const commandDescriptions = {
        "computer-use":
          "AI computer-use execution command. Requires --task and supports --max-steps / --speed-mode / --run-id.",
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                profiles,
                targets,
                commands,
                commandDescriptions,
                backendBaseUrl: backendBaseUrl(),
                tokenConfigured: Boolean(backendToken()),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcpServer.registerTool(
    "uiq_server_selfcheck",
    {
      description:
        "Self-check MCP runtime readiness: paths, configs/profiles, configs/targets, backend health, and recent runs.",
      inputSchema: {},
    },
    async () => {
      const profiles = listYamlStemNames(resolveCatalogYamlDir("profiles"));
      const targets = listYamlStemNames(resolveCatalogYamlDir("targets"));
      const latest = latestRunId() ?? null;
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      checks.push({
        name: "profiles_present",
        ok: profiles.length > 0,
        detail: `profiles=${profiles.length}`,
      });
      checks.push({
        name: "targets_present",
        ok: targets.length > 0,
        detail: `targets=${targets.length}`,
      });
      checks.push({ name: "runs_dir", ok: ensureDirReady(runsRoot()), detail: runsRoot() });
      checks.push({
        name: "audit_log_dir",
        ok: ensureDirReady(resolve(repoRoot(), ".runtime-cache/logs")),
        detail: ".runtime-cache/logs",
      });

      let backendOk = false;
      let backendDetail = "";
      try {
        const res = await apiRequest("/health/");
        backendOk = res.ok;
        backendDetail = `status=${res.status} baseUrl=${backendBaseUrl()}`;
      } catch (error) {
        backendOk = false;
        backendDetail = `error=${(error as Error).message}`;
      }
      checks.push({ name: "backend_health", ok: backendOk, detail: backendDetail });
      const ok = checks.every((c) => c.ok);
      writeAudit({
        type: "server_selfcheck",
        ok,
        detail: checks.map((c) => `${c.name}:${c.ok}`).join(","),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok,
                checks,
                latestRunId: latest,
                backendBaseUrl: backendBaseUrl(),
                tokenConfigured: Boolean(backendToken()),
              },
              null,
              2,
            ),
          },
        ],
        isError: !ok,
      };
    },
  );

  mcpServer.registerTool(
    "uiq_run_profile",
    {
      description: "Run UIQ profile with full CLI overrides and return run outputs.",
      inputSchema: {
        profile: z.string(),
        target: z.string(),
        runId: z.string().optional(),
        ...runOverrideSchema,
      },
    },
    async ({ profile, target, runId, ...overrides }) => {
      try {
        return await withGovernedExecution("uiq_run_profile", async ({ timeoutMs }) => {
          const safeProfile = sanitizeProfileTarget("profile", profile);
          const safeTarget = sanitizeProfileTarget("target", target);
          const safeRunId = runId ? sanitizeRunId(runId) : undefined;
          const args = ["run", "--profile", safeProfile, "--target", safeTarget];
          if (safeRunId) {
            args.push("--run-id", safeRunId);
          }
          appendRunOverrides(args, overrides);
          const warnings = desktopInputWarnings({
            profile: safeProfile,
            target: safeTarget,
            app: overrides.app,
            bundleId: overrides.bundleId,
          });
          const result = runUiqSync(args, timeoutMs);
          if (!result.ok) {
            return governedErrorResponse(
              "uiq_run_profile",
              classifyRunFailureReasonCode(result),
              `uiq_run_profile failed: ${result.detail}`,
              {
                exitCode: result.exitCode,
                runId: result.runId ?? null,
                manifest: result.manifest ?? null,
              },
            );
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...result, warnings }, null, 2),
              },
            ],
          };
        });
      } catch (error) {
        const classified = classifyGovernedToolError("uiq_run_profile", error);
        return governedErrorResponse(
          "uiq_run_profile",
          classified.reasonCode,
          classified.detail,
          classified.meta,
        );
      }
    },
  );

  if (enableAdvanced) {
    mcpServer.registerTool(
      "uiq_run_command",
      {
        description: "Run a single UIQ command with full CLI overrides.",
        inputSchema: {
          command: z.string(),
          target: z.string().optional(),
          profile: z.string().optional(),
          runId: z.string().optional(),
          ...runOverrideSchema,
        },
      },
      async ({ command, target, profile, runId, ...overrides }) => {
        try {
          return await withGovernedExecution(
            GOVERNED_TOOL_UIQ_RUN_COMMAND,
            async ({ timeoutMs }) => {
              const executed = executeRunCommand({
                command,
                target,
                profile,
                runId,
                overrides,
                timeoutMs,
              });
              if (!executed.result.ok) {
                return governedErrorResponse(
                  GOVERNED_TOOL_UIQ_RUN_COMMAND,
                  classifyRunFailureReasonCode(executed.result),
                  `uiq_run_command failed: ${executed.result.detail}`,
                  {
                    exitCode: executed.result.exitCode,
                    runId: executed.result.runId ?? null,
                    manifest: executed.result.manifest ?? null,
                    stdout: executed.result.stdout,
                    stderr: executed.result.stderr,
                  },
                );
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      { ...executed.result, warnings: executed.warnings },
                      null,
                      2,
                    ),
                  },
                ],
              };
            },
          );
        } catch (error) {
          const classified = classifyGovernedToolError(GOVERNED_TOOL_UIQ_RUN_COMMAND, error);
          return governedErrorResponse(
            GOVERNED_TOOL_UIQ_RUN_COMMAND,
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );

    mcpServer.registerTool(
      "uiq_computer_use_run",
      {
        description: RUN_TOOL_DESCRIPTIONS.computerUseRun,
        inputSchema: {
          task: z.string().min(1),
          maxSteps: z.number().int().min(1).max(10_000).optional(),
          speedMode: z.boolean().optional(),
          runId: z.string().optional(),
        },
      },
      async ({ task, maxSteps, speedMode, runId }) => {
        try {
          return await withGovernedExecution(
            GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN,
            async ({ timeoutMs }) => {
              const trimmedTask = task.trim();
              if (!trimmedTask) {
                return governedErrorResponse(
                  GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN,
                  "INVALID_INPUT",
                  "uiq_computer_use_run failed: task is required and cannot be empty",
                );
              }
              const extraArgs = ["--task", trimmedTask];
              if (maxSteps !== undefined) {
                extraArgs.push("--max-steps", String(maxSteps));
              }
              if (speedMode !== undefined) {
                extraArgs.push("--speed-mode", speedMode ? "true" : "false");
              }
              const executed = executeRunCommand({
                command: "computer-use",
                runId,
                extraArgs,
                timeoutMs,
              });
              if (!executed.result.ok) {
                return governedErrorResponse(
                  GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN,
                  classifyRunFailureReasonCode(executed.result),
                  `uiq_computer_use_run failed: ${executed.result.detail}`,
                  {
                    exitCode: executed.result.exitCode,
                    runId: executed.result.runId ?? null,
                    manifest: executed.result.manifest ?? null,
                    stdout: executed.result.stdout,
                    stderr: executed.result.stderr,
                  },
                );
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      { ...executed.result, warnings: executed.warnings },
                      null,
                      2,
                    ),
                  },
                ],
              };
            },
          );
        } catch (error) {
          const classified = classifyGovernedToolError(GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN, error);
          return governedErrorResponse(
            GOVERNED_TOOL_UIQ_COMPUTER_USE_RUN,
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );
  }

  mcpServer.registerTool(
    "uiq_run_stream",
    {
      description: "Run UIQ profile/command with structured line events (stdout/stderr).",
      inputSchema: {
        mode: z.enum(["profile", "command"]),
        profile: z.string().optional(),
        command: z.string().optional(),
        target: z.string().optional(),
        runId: z.string().optional(),
        timeoutMs: z.number().int().optional(),
        ...runOverrideSchema,
      },
    },
    async ({ mode, profile, command, target, runId, timeoutMs, ...overrides }) => {
      try {
        return await withGovernedExecution(
          GOVERNED_TOOL_UIQ_RUN_STREAM,
          async ({ timeoutMs: governedTimeoutMs }) => {
            const args: string[] = [];
            if (mode === "profile") {
              if (!profile || !target) {
                return governedErrorResponse(
                  GOVERNED_TOOL_UIQ_RUN_STREAM,
                  "INVALID_INPUT",
                  "uiq_run_stream failed: profile and target are required for mode=profile",
                );
              }
              const safeProfile = sanitizeProfileTarget("profile", profile);
              const safeTarget = sanitizeProfileTarget("target", target);
              args.push("run", "--profile", safeProfile, "--target", safeTarget);
            } else {
              if (!command) {
                return governedErrorResponse(
                  GOVERNED_TOOL_UIQ_RUN_STREAM,
                  "INVALID_INPUT",
                  "uiq_run_stream failed: command is required for mode=command",
                );
              }
              args.push(command);
              const safeTarget = target ? sanitizeProfileTarget("target", target) : undefined;
              const safeProfile = profile ? sanitizeProfileTarget("profile", profile) : undefined;
              if (safeTarget) {
                args.push("--target", safeTarget);
              }
              if (safeProfile) {
                args.push("--profile", safeProfile);
              }
            }
            const safeRunId = runId ? sanitizeRunId(runId) : undefined;
            if (safeRunId) {
              args.push("--run-id", safeRunId);
            }
            appendRunOverrides(args, overrides);
            const effectiveTimeoutMs = Math.max(
              1,
              Math.min(timeoutMs ?? 10 * 60 * 1000, governedTimeoutMs),
            );
            const result = await runUiqStream(args, effectiveTimeoutMs);
            if (!result.ok) {
              return governedErrorResponse(
                GOVERNED_TOOL_UIQ_RUN_STREAM,
                classifyRunFailureReasonCode(result),
                `uiq_run_stream failed: ${result.detail}`,
                {
                  exitCode: result.exitCode,
                  runId: result.runId ?? null,
                  manifest: result.manifest ?? null,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  elapsedMs: result.elapsedMs,
                  timedOut: result.timedOut,
                  killStage: result.killStage,
                },
              );
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          },
        );
      } catch (error) {
        const classified = classifyGovernedToolError(GOVERNED_TOOL_UIQ_RUN_STREAM, error);
        return governedErrorResponse(
          GOVERNED_TOOL_UIQ_RUN_STREAM,
          classified.reasonCode,
          classified.detail,
          classified.meta,
        );
      }
    },
  );

  mcpServer.registerTool(
    "uiq_run_overview",
    {
      description: "Get concise run gate overview by runId (or latest when omitted).",
      inputSchema: {
        runId: z.string().optional(),
      },
    },
    async ({ runId }) => {
      try {
        const id = pickRunIdOrLatest(runId);
        const overview = readRunOverview(id);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, ...overview }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, detail: (error as Error).message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  if (enableAdvanced) {
    mcpServer.registerTool(
      "uiq_list_runs",
      {
        description: "List latest run IDs under .runtime-cache/artifacts/runs",
        inputSchema: { limit: z.number().int().optional() },
      },
      async ({ limit }) => ({
        content: [
          { type: "text", text: JSON.stringify({ runs: listRunIds(limit ?? 20) }, null, 2) },
        ],
      }),
    );

    mcpServer.registerTool(
      "uiq_read_manifest",
      { description: "Read manifest.json for one runId", inputSchema: { runId: z.string() } },
      async ({ runId }) => {
        try {
          return await withGovernedExecution("uiq_read_manifest", async () => {
            const text = redactSensitiveText(
              readUtf8(safeResolveUnder(runsRoot(), runId, "manifest.json")),
            );
            return { content: [{ type: "text", text }] };
          });
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_read_manifest", error);
          return governedErrorResponse(
            "uiq_read_manifest",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );
  }

  mcpServer.registerTool(
    "uiq_read_artifact",
    {
      description: "Read text artifact by runId + relativePath",
      inputSchema: { runId: z.string(), relativePath: z.string() },
    },
    async ({ runId, relativePath }) => {
      try {
        return await withGovernedExecution(GOVERNED_TOOL_UIQ_READ_ARTIFACT, async () => {
          const abs = safeResolveUnder(runsRoot(), runId, relativePath);
          const text = redactSensitiveText(readUtf8(abs));
          return { content: [{ type: "text", text }] };
        });
      } catch (error) {
        const classified = classifyGovernedToolError(GOVERNED_TOOL_UIQ_READ_ARTIFACT, error);
        return governedErrorResponse(
          GOVERNED_TOOL_UIQ_READ_ARTIFACT,
          classified.reasonCode,
          classified.detail,
          classified.meta,
        );
      }
    },
  );

  if (enableAdvanced) {
    mcpServer.registerTool(
      "uiq_read_repo_doc",
      {
        description: "Read repository docs/config (allowlisted paths).",
        inputSchema: { relativePath: z.string() },
      },
      async ({ relativePath }) => {
        try {
          return await withGovernedExecution(GOVERNED_TOOL_UIQ_READ_REPO_DOC, async () => {
            const text = redactSensitiveText(readRepoTextFile(relativePath));
            return { content: [{ type: "text", text }] };
          });
        } catch (error) {
          const classified = classifyGovernedToolError(GOVERNED_TOOL_UIQ_READ_REPO_DOC, error);
          return governedErrorResponse(
            GOVERNED_TOOL_UIQ_READ_REPO_DOC,
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );
  }

  mcpServer.registerTool(
    "uiq_gate_failures",
    {
      description: "Read failed/blocked gate checks from summary.json",
      inputSchema: { runId: z.string().optional() },
    },
    async ({ runId }) => {
      try {
        const id = pickRunIdOrLatest(runId);
        const overview = readRunOverview(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { runId: id, gateStatus: overview.gateStatus, failedChecks: overview.failedChecks },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, detail: `uiq_gate_failures failed: ${(error as Error).message}` },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  if (enableAdvanced) {
    mcpServer.registerTool(
      "uiq_summarize_failures",
      {
        description: "Summarize failed/blocked gate checks for one run (or latest).",
        inputSchema: { runId: z.string().optional() },
      },
      async ({ runId }) => {
        try {
          return await withGovernedExecution("uiq_summarize_failures", async () => {
            const id = pickRunIdOrLatest(runId);
            const overview = readRunOverview(id);
            const grouped = overview.failedChecks.reduce<Record<string, number>>((acc, item) => {
              const key = item.reasonCode ?? "unspecified";
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {});
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      runId: id,
                      gateStatus: overview.gateStatus,
                      totalFailures: overview.failedChecks.length,
                      byReasonCode: grouped,
                      failedChecks: overview.failedChecks,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          });
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_summarize_failures", error);
          return governedErrorResponse(
            "uiq_summarize_failures",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );
  }

  if (enableAnalysis) {
    mcpServer.registerTool(
      "uiq_a11y_top",
      {
        description: "Read top a11y issues from a11y/axe.json",
        inputSchema: { runId: z.string().optional(), topN: z.number().int().optional() },
      },
      async ({ runId, topN }) => {
        try {
          const id = pickRunIdOrLatest(runId);
          const analyzed = analyzeA11y(id, topN ?? 10);
          return { content: [{ type: "text", text: JSON.stringify(analyzed, null, 2) }] };
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_a11y_top", error);
          return governedErrorResponse(
            "uiq_a11y_top",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );

    mcpServer.registerTool(
      "uiq_perf_metrics",
      {
        description: "Read perf metrics from perf/lighthouse.json",
        inputSchema: { runId: z.string().optional() },
      },
      async ({ runId }) => {
        try {
          const id = pickRunIdOrLatest(runId);
          return { content: [{ type: "text", text: JSON.stringify(analyzePerf(id), null, 2) }] };
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_perf_metrics", error);
          return governedErrorResponse(
            "uiq_perf_metrics",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );

    mcpServer.registerTool(
      "uiq_visual_status",
      {
        description: "Read visual diff status from visual/report.json",
        inputSchema: { runId: z.string().optional() },
      },
      async ({ runId }) => {
        try {
          const id = pickRunIdOrLatest(runId);
          return { content: [{ type: "text", text: JSON.stringify(analyzeVisual(id), null, 2) }] };
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_visual_status", error);
          return governedErrorResponse(
            "uiq_visual_status",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );

    mcpServer.registerTool(
      "uiq_security_summary",
      {
        description: "Read security report + ticket summary",
        inputSchema: { runId: z.string().optional() },
      },
      async ({ runId }) => {
        try {
          const id = pickRunIdOrLatest(runId);
          return {
            content: [{ type: "text", text: JSON.stringify(analyzeSecurity(id), null, 2) }],
          };
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_security_summary", error);
          return governedErrorResponse(
            "uiq_security_summary",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );

    mcpServer.registerTool(
      "uiq_compare_perf",
      {
        description: "Compare perf metrics between two runs",
        inputSchema: { runIdA: z.string(), runIdB: z.string() },
      },
      async ({ runIdA, runIdB }) => {
        try {
          const payload = (await proofApiPost("/api/proof/runs/compare", {
            left_run_id: runIdA,
            right_run_id: runIdB,
          })) as {
            metrics_delta?: { values?: Record<string, unknown> };
            compare?: { metrics_delta?: { values?: Record<string, unknown> } };
          };
          const deltas =
            payload.metrics_delta?.values ??
            payload.compare?.metrics_delta?.values ??
            {};
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    runA: runIdA,
                    runB: runIdB,
                    deltas,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          const classified = classifyGovernedToolError("uiq_compare_perf", error);
          return governedErrorResponse(
            "uiq_compare_perf",
            classified.reasonCode,
            classified.detail,
            classified.meta,
          );
        }
      },
    );
  }

  if (enableProof) {
    mcpServer.registerTool(
      "uiq_model_target_capabilities",
      {
        description:
          "Describe proof campaign capability matrix across model + target combinations.",
        inputSchema: {
          model: z.string().optional(),
        },
      },
      async ({ model }) => {
        return withProofGuard("uiq_model_target_capabilities", async () => {
          const capabilities = buildModelTargetCapabilities(model?.trim() || "proof-v1");
          return { content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }] };
        });
      },
    );

    mcpServer.registerTool(
      "uiq_run_proof_campaign",
      {
        description:
          "Build a structured proof campaign from one or more existing run artifacts and persist it to disk.",
        inputSchema: {
          campaignId: z.string().optional(),
          model: z.string().optional(),
          name: z.string().optional(),
          description: z.string().optional(),
          runIds: z.array(z.string()).optional(),
          baselineCampaignId: z.string().optional(),
        },
      },
      async ({ campaignId, model, name, description, runIds, baselineCampaignId }) => {
        return withProofGuard("uiq_run_proof_campaign", async () => {
          const selectedRunIds = runIds?.length ? runIds : [pickRunIdOrLatest(undefined)];
          const response = (await proofApiPost("/api/proof/campaigns", {
            model: model?.trim() || "proof-v1",
            name,
            description,
            run_ids: selectedRunIds,
          })) as { campaign?: { campaign_id?: string }; report?: Record<string, unknown> };
          const finalCampaignId = String(response?.campaign?.campaign_id || "").trim();
          if (!finalCampaignId) {
            throw new Error("proof campaign create response missing campaign_id");
          }
          const baselineId = baselineCampaignId?.trim();
          const baselineDiff =
            baselineId && baselineId !== finalCampaignId
              ? (() => {
                  return null;
                })()
              : null;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    campaignId: finalCampaignId,
                    runIds: selectedRunIds,
                    model: response?.report?.model ?? null,
                    ok: response?.report?.ok === true,
                    policyMode: response?.report?.policyMode ?? "strict",
                    reasonCodes: response?.report?.reasonCodes ?? [],
                    stats: response?.report?.stats ?? {},
                    baselineDiff,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        });
      },
    );

    mcpServer.registerTool(
      "uiq_read_proof_report",
      {
        description: "Read one persisted proof campaign report (defaults to latest).",
        inputSchema: {
          campaignId: z.string().optional(),
        },
      },
      async ({ campaignId }) => {
        return withProofGuard("uiq_read_proof_report", async () => {
          let id = campaignId?.trim();
          if (!id) {
            const listed = (await proofApiGet("/api/proof/campaigns")) as {
              campaigns?: Array<{ campaign_id?: string }>;
            };
            id = String(listed?.campaigns?.[0]?.campaign_id || "").trim();
          }
          if (!id) {
            throw new Error("no proof campaigns found");
          }
          const report = await proofApiGet(`/api/proof/campaigns/${encodeURIComponent(id)}`);
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        });
      },
    );

    mcpServer.registerTool(
      "uiq_export_proof_bundle",
      {
        description:
          "Export normalized proof bundle JSON for downstream CI/reporting (defaults to latest campaign).",
        inputSchema: {
          campaignId: z.string().optional(),
          includeRunReports: z.boolean().optional(),
        },
      },
      async ({ campaignId, includeRunReports }) => {
        return withProofGuard("uiq_export_proof_bundle", async () => {
          let id = campaignId?.trim();
          if (!id) {
            const listed = (await proofApiGet("/api/proof/campaigns")) as {
              campaigns?: Array<{ campaign_id?: string }>;
            };
            id = String(listed?.campaigns?.[0]?.campaign_id || "").trim();
          }
          if (!id) {
            throw new Error("no proof campaigns found");
          }
          const response = (await proofApiGet(
            `/api/proof/campaigns/${encodeURIComponent(id)}`,
          )) as { campaign?: Record<string, unknown>; report?: Record<string, unknown> };
          const report = response?.report ?? {};
          const runReports = Array.isArray((report as { runReports?: unknown[] }).runReports)
            ? ((report as { runReports?: unknown[] }).runReports ?? [])
            : [];
          const bundle = {
            schemaVersion: 1,
            campaignId: id,
            model: (report as { model?: unknown }).model ?? null,
            generatedAt: (report as { generatedAt?: unknown }).generatedAt ?? null,
            ok: (report as { ok?: unknown }).ok ?? null,
            policyMode: (report as { policyMode?: unknown }).policyMode ?? "strict",
            reasonCodes: (report as { reasonCodes?: unknown }).reasonCodes ?? [],
            policy: (report as { policy?: unknown }).policy ?? {},
            runIds: (report as { runIds?: unknown }).runIds ?? [],
            stats: (report as { stats?: unknown }).stats ?? {},
            failedCheckHistogram: (report as { failedCheckHistogram?: unknown }).failedCheckHistogram ?? {},
            ...(includeRunReports ? { runReports } : {}),
          };
          const exportPath = safeResolveUnder(proofCampaignsRoot(), id, "campaign.bundle.json");
          writeJson(exportPath, bundle);
          writeAudit({ type: "uiq_export_proof_bundle", ok: true, detail: `campaign=${id}` });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...bundle, exportPath }, null, 2),
              },
            ],
          };
        });
      },
    );

    mcpServer.registerTool(
      "uiq_diff_proof_campaign",
      {
        description: "Diff two proof campaigns and persist a structured diff artifact.",
        inputSchema: {
          campaignIdA: z.string(),
          campaignIdB: z.string(),
        },
      },
      async ({ campaignIdA, campaignIdB }) => {
        return withProofGuard("uiq_diff_proof_campaign", async () => {
          const response = (await proofApiPost(
            `/api/proof/campaigns/${encodeURIComponent(campaignIdA)}/diff`,
            { other_campaign_id: campaignIdB },
          )) as { diff?: Record<string, unknown> };
          const diff = response?.diff ?? {};
          const diffPath = safeResolveUnder(
            proofCampaignsRoot(),
            campaignIdA,
            `campaign.diff.${campaignIdB}.json`,
          );
          writeJson(diffPath, diff);
          return {
            content: [{ type: "text", text: JSON.stringify({ ...diff, diffPath }, null, 2) }],
          };
        });
      },
    );

    mcpServer.registerTool(
      "uiq_read_run_ai_review",
      {
        description:
          "Read the backend AI review projection for one run. Helpful summary layer only; validate against the linked evidence before deciding.",
        inputSchema: {
          runId: z.string(),
        },
      },
      async ({ runId }) =>
        withProofGuard("uiq_read_run_ai_review", async () => {
          const review = await proofApiGet(`/api/proof/runs/${encodeURIComponent(runId)}/ai-review`);
          return { content: [{ type: "text", text: JSON.stringify(review, null, 2) }] };
        }),
    );

    mcpServer.registerTool(
      "uiq_generate_release_brief",
      {
        description:
          "Draft a release brief from governed evidence. This is a read-only summary layer over existing proof and compare data, not a new truth source.",
        inputSchema: {
          runId: z.string(),
          baselineRunId: z.string().optional(),
        },
      },
      async ({ runId, baselineRunId }) =>
        withProofGuard("uiq_generate_release_brief", async () => {
          const suffix = baselineRunId?.trim()
            ? `?baseline_run_id=${encodeURIComponent(baselineRunId.trim())}`
            : "";
          const brief = await proofApiGet(
            `/api/proof/runs/${encodeURIComponent(runId)}/release-brief${suffix}`,
          );
          return { content: [{ type: "text", text: JSON.stringify(brief, null, 2) }] };
        }),
    );

    mcpServer.registerTool(
      "uiq_find_similar_failures",
      {
        description:
          "Search governed failure evidence for similar past runs. Returns ranked matches with source run ids and why they matched.",
        inputSchema: {
          runId: z.string(),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      async ({ runId, limit }) =>
        withProofGuard("uiq_find_similar_failures", async () => {
          const query = typeof limit === "number" ? `?limit=${limit}` : "";
          const matches = await proofApiGet(
            `/api/proof/runs/${encodeURIComponent(runId)}/similar-failures${query}`,
          );
          return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
        }),
    );

    mcpServer.registerTool(
      "uiq_explain_template_feasibility",
      {
        description:
          "Explain whether a template can move across targets. Reads the backend feasibility truth and adds a short explanation, but does not change template state.",
        inputSchema: {
          templateId: z.string(),
          target: z.string(),
        },
      },
      async ({ templateId, target }) =>
        withProofGuard("uiq_explain_template_feasibility", async () => {
          const payload = (await proofApiGet(
            `/api/proof/templates/${encodeURIComponent(templateId)}/feasibility?target=${encodeURIComponent(target)}`,
          )) as { supported?: boolean; blocked_reasons?: string[]; migration_hints?: string[]; required_capabilities?: string[] };
          const explanation = payload.supported
            ? "Supported. Review the required capabilities and migration hints before promoting the template."
            : "Not ready. Inspect blocked reasons and migration hints before forking or switching targets.";
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...payload, explanation }, null, 2),
              },
            ],
          };
        }),
    );

    mcpServer.registerTool(
      "uiq_list_manual_gates",
      {
        description:
          "Read the current manual-gate inbox from workflow runs. This is a read-only operator summary over paused runs and does not resume them.",
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async ({ limit }) =>
        withProofGuard("uiq_list_manual_gates", async () => {
          const response = await apiRequest(`/api/runs?limit=${encodeURIComponent(String(limit ?? 100))}`);
          if (!response.ok) {
            throw new Error(typeof response.body === "string" ? response.body : `request failed: ${response.status}`);
          }
          const payload = response.json ?? {};
          const runs = Array.isArray(payload.runs) ? payload.runs : [];
          const waitingRuns = runs.filter((run) => {
            const status = typeof run?.status === "string" ? run.status : "";
            return status === "waiting_user" || status === "waiting_otp";
          });
          const reasons = waitingRuns.reduce((acc, run) => {
            const reason =
              typeof run?.wait_context?.reason_code === "string" && run.wait_context.reason_code
                ? run.wait_context.reason_code
                : typeof run?.status === "string"
                  ? run.status
                  : "manual_review";
            acc[reason] = (acc[reason] ?? 0) + 1;
            return acc;
          }, {});
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ totalWaiting: waitingRuns.length, reasons, runs: waitingRuns }, null, 2),
              },
            ],
          };
        }),
    );
  }
}
