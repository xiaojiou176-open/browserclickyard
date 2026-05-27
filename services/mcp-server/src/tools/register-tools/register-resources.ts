// @ts-nocheck
// 
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiRequest } from "../../core/api-client.js";
import { readUtf8, runsRoot, safeResolveUnder } from "../../core/constants.js";
import {
  classifyGovernedToolError,
  governedErrorPayload,
  withGovernedExecution,
} from "../../core/governance.js";
import { redactSensitiveText } from "../../core/redaction.js";
import { latestRunId } from "./shared.js";

async function readJsonResource(path: string): Promise<string> {
  const response = await apiRequest(path);
  if (!response.ok) {
    throw new Error(typeof response.body === "string" ? response.body : `request failed: ${response.status}`);
  }
  const payload = response.json ?? {};
  return redactSensitiveText(JSON.stringify(payload, null, 2));
}

export function registerMcpResources(mcpServer: McpServer): void {
  mcpServer.registerResource(
    "uiq-latest-manifest",
    "uiq://runs/latest/manifest",
    {
      title: "Latest UIQ Manifest",
      description: "Latest run manifest.json in this workspace",
      mimeType: "application/json",
    },
    async () => {
      try {
        return await withGovernedExecution("uiq_resource_latest_manifest", async () => {
          const runId = latestRunId();
          if (!runId) {
            return {
              contents: [
                {
                  uri: "uiq://runs/latest/manifest",
                  text: JSON.stringify({ error: "no runs found" }, null, 2),
                },
              ],
            };
          }
          return {
            contents: [
              {
                uri: "uiq://runs/latest/manifest",
                text: redactSensitiveText(
                  readUtf8(safeResolveUnder(runsRoot(), runId, "manifest.json")),
                ),
              },
            ],
          };
        });
      } catch (error) {
        const classified = classifyGovernedToolError("uiq_resource_latest_manifest", error);
        return {
          contents: [
            {
              uri: "uiq://runs/latest/manifest",
              text: JSON.stringify(
                governedErrorPayload(
                  "uiq_resource_latest_manifest",
                  classified.reasonCode,
                  classified.detail,
                  classified.meta,
                ),
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  mcpServer.registerResource(
    "uiq-latest-summary",
    "uiq://runs/latest/summary",
    {
      title: "Latest UIQ Summary",
      description: "Latest run reports/summary.json in this workspace",
      mimeType: "application/json",
    },
    async () => {
      try {
        return await withGovernedExecution("uiq_resource_latest_summary", async () => {
          const runId = latestRunId();
          if (!runId) {
            return {
              contents: [
                {
                  uri: "uiq://runs/latest/summary",
                  text: JSON.stringify({ error: "no runs found" }, null, 2),
                },
              ],
            };
          }
          return {
            contents: [
              {
                uri: "uiq://runs/latest/summary",
                text: redactSensitiveText(
                  readUtf8(safeResolveUnder(runsRoot(), runId, "reports/summary.json")),
                ),
              },
            ],
          };
        });
      } catch (error) {
        const classified = classifyGovernedToolError("uiq_resource_latest_summary", error);
        return {
          contents: [
            {
              uri: "uiq://runs/latest/summary",
              text: JSON.stringify(
                governedErrorPayload(
                  "uiq_resource_latest_summary",
                  classified.reasonCode,
                  classified.detail,
                  classified.meta,
                ),
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  mcpServer.registerResource(
    "uiq-latest-release-brief",
    "uiq://review/latest-release-brief",
    {
      title: "Latest Release Brief",
      description: "Read-only context for the latest run release brief. Selected by the app, not written back by AI.",
      mimeType: "application/json",
    },
    async () => {
      try {
        return await withGovernedExecution("uiq_resource_latest_release_brief", async () => {
          const runId = latestRunId();
          if (!runId) {
            return {
              contents: [
                {
                  uri: "uiq://review/latest-release-brief",
                  text: JSON.stringify({ error: "no runs found" }, null, 2),
                },
              ],
            };
          }
          return {
            contents: [
              {
                uri: "uiq://review/latest-release-brief",
                text: await readJsonResource(`/api/proof/runs/${encodeURIComponent(runId)}/release-brief`),
              },
            ],
          };
        });
      } catch (error) {
        const classified = classifyGovernedToolError("uiq_resource_latest_release_brief", error);
        return {
          contents: [
            {
              uri: "uiq://review/latest-release-brief",
              text: JSON.stringify(
                governedErrorPayload(
                  "uiq_resource_latest_release_brief",
                  classified.reasonCode,
                  classified.detail,
                  classified.meta,
                ),
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  mcpServer.registerResource(
    "uiq-manual-gates-summary",
    "uiq://manual-gates/inbox-summary",
    {
      title: "Manual Gates Inbox Summary",
      description: "Read-only context for paused workflow runs that need operator help.",
      mimeType: "application/json",
    },
    async () => {
      try {
        return await withGovernedExecution("uiq_resource_manual_gates_summary", async () => {
          const response = await apiRequest("/api/runs?limit=100");
          if (!response.ok) {
            throw new Error(typeof response.body === "string" ? response.body : `request failed: ${response.status}`);
          }
          const payload = response.json ?? {};
          const runs = Array.isArray(payload.runs) ? payload.runs : [];
          const waitingRuns = runs.filter((run) => {
            const status = typeof run?.status === "string" ? run.status : "";
            return status === "waiting_user" || status === "waiting_otp";
          });
          const grouped = waitingRuns.reduce((acc, run) => {
            const reason =
              (typeof run?.wait_context?.reason_code === "string" && run.wait_context.reason_code) ||
              statusLabel(run?.status) ||
              "manual_review";
            acc[reason] = (acc[reason] ?? 0) + 1;
            return acc;
          }, {});
          return {
            contents: [
              {
                uri: "uiq://manual-gates/inbox-summary",
                text: redactSensitiveText(
                  JSON.stringify(
                    {
                      totalWaiting: waitingRuns.length,
                      reasons: grouped,
                      runs: waitingRuns.map((run) => ({
                        run_id: run.run_id,
                        status: run.status,
                        reason_code: run.wait_context?.reason_code ?? null,
                        screen_title: run.wait_context?.screen_title ?? null,
                        allowed_resume_kinds: run.wait_context?.allowed_resume_kinds ?? [],
                      })),
                    },
                    null,
                    2,
                  ),
                ),
              },
            ],
          };
        });
      } catch (error) {
        const classified = classifyGovernedToolError("uiq_resource_manual_gates_summary", error);
        return {
          contents: [
            {
              uri: "uiq://manual-gates/inbox-summary",
              text: JSON.stringify(
                governedErrorPayload(
                  "uiq_resource_manual_gates_summary",
                  classified.reasonCode,
                  classified.detail,
                  classified.meta,
                ),
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}

function statusLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
