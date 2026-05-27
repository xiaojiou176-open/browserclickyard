// @ts-nocheck
// 
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  apiCreateRun,
  apiCreateTemplate,
  apiFinishSession,
  apiGetFlow,
  apiGetRun,
  apiGetTemplate,
  apiImportLatestFlow,
  apiListSessions,
  apiStartSession,
  extractRunId,
  parseRunStatus,
  readFirstString,
} from "../../core/api-client.js";
import {
  backendRuntimeStatus,
  startBackendRuntime,
  stopBackendRuntime,
} from "../../core/runtime-manager.js";
import type { JsonObject } from "../../core/types.js";
import { CORE_TOOL_DESCRIPTIONS } from "./descriptions.js";
import {
  buildRegisterTemplatePayload,
  buildTemplateName,
  normalizeOrchestrateMode,
  pollRunToTerminal,
  runAutomationTeach,
} from "./shared.js";

export function registerCoreClosedLoopTools(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "uiq_backend_runtime",
    {
      description: CORE_TOOL_DESCRIPTIONS.backendRuntime,
      inputSchema: {
        action: z.enum(["start", "status", "stop"]),
        preferredPort: z.number().int().optional(),
      },
    },
    async ({ action, preferredPort }) => {
      try {
        const runtime =
          action === "start"
            ? await startBackendRuntime(preferredPort)
            : action === "stop"
              ? await stopBackendRuntime()
              : await backendRuntimeStatus();
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: runtime.ok, action, runtime }, null, 2) },
          ],
          isError: !runtime.ok,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, action, detail: (error as Error).message },
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

  mcpServer.registerTool(
    "uiq_api_sessions",
    {
      description: CORE_TOOL_DESCRIPTIONS.apiSessions,
      inputSchema: {
        action: z.enum(["list", "start", "finish"]),
        sessionId: z.string().optional(),
        limit: z.number().int().optional(),
        startUrl: z.string().optional(),
        mode: z.string().optional(),
      },
    },
    async ({ action, sessionId, limit, startUrl, mode }) => {
      try {
        let payload: JsonObject | JsonObject[];
        if (action === "list") {
          payload = await apiListSessions(limit ?? 30);
        } else if (action === "start") {
          if (!startUrl?.trim()) {
            throw new Error("startUrl is required for action=start");
          }
          payload = await apiStartSession(startUrl, mode ?? "manual");
        } else {
          if (!sessionId?.trim()) {
            throw new Error("sessionId is required for action=finish");
          }
          payload = await apiFinishSession(sessionId);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, action, payload }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, action, detail: (error as Error).message },
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
}

export function registerRegisterTools(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "uiq_register_orchestrate",
    {
      description: CORE_TOOL_DESCRIPTIONS.registerOrchestrate,
      inputSchema: {
        action: z.enum(["prepare", "teach", "clone", "resume"]),
        startUrl: z.string().optional(),
        sessionId: z.string().optional(),
        templateId: z.string().optional(),
        runId: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional(),
        otpCode: z.string().optional(),
        mode: z.string().optional(),
        successSelector: z.string().optional(),
        headless: z.boolean().optional(),
        otpProvider: z.string().optional(),
        otpSenderFilter: z.string().optional(),
        otpSubjectFilter: z.string().optional(),
        stripeCardNumber: z.string().optional(),
        stripeExpMonth: z.string().optional(),
        stripeExpYear: z.string().optional(),
        stripeCvc: z.string().optional(),
        stripeCardholderName: z.string().optional(),
        stripePostalCode: z.string().optional(),
        stripeCountry: z.string().optional(),
        pollTimeoutSeconds: z.number().int().optional(),
        pollIntervalSeconds: z.number().int().optional(),
      },
    },
    async ({
      action,
      startUrl,
      sessionId,
      templateId,
      runId,
      email,
      password,
      otpCode,
      mode,
      successSelector,
      headless,
      otpProvider,
      otpSenderFilter,
      otpSubjectFilter,
      stripeCardNumber,
      stripeExpMonth,
      stripeExpYear,
      stripeCvc,
      stripeCardholderName,
      stripePostalCode,
      stripeCountry,
      pollTimeoutSeconds,
      pollIntervalSeconds,
    }) => {
      const timeout = pollTimeoutSeconds ?? 180;
      const interval = pollIntervalSeconds ?? 5;
      const provider = (otpProvider ?? "gmail").trim().toLowerCase();
      const normalizedMode = normalizeOrchestrateMode(mode);
      try {
        const runtime = await startBackendRuntime();
        if (action === "prepare") {
          const prepared = startUrl?.trim()
            ? await apiStartSession(startUrl, normalizedMode ?? "manual")
            : null;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, action, runtime, preparedSession: prepared },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "teach") {
          if (!startUrl?.trim()) {
            throw new Error("startUrl is required for action=teach");
          }
          const teach = runAutomationTeach({
            mode: mode ?? "midscene",
            startUrl: startUrl.trim(),
            sessionId: sessionId?.trim(),
            successSelector: successSelector?.trim(),
            headless,
          });
          if (!teach.ok) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: false, action, runtime, teach }, null, 2),
                },
              ],
              isError: true,
            };
          }
          const importedFlow = await apiImportLatestFlow();
          const flowId = readFirstString(importedFlow, ["flow_id", "flowId"]);
          if (!flowId) {
            throw new Error("import_latest did not return flow_id");
          }
          const templatePayload = buildRegisterTemplatePayload(
            flowId,
            buildTemplateName(startUrl),
            email,
            password,
            provider,
          );
          const template = await apiCreateTemplate(templatePayload);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, action, runtime, teach, importedFlow, template },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "clone") {
          if (!templateId?.trim()) {
            throw new Error("templateId is required for action=clone");
          }
          const params: JsonObject = {};
          if (email?.trim()) {
            params.email = email.trim();
          }
          if (password?.trim()) {
            params.password = password.trim();
          }
          if (normalizedMode) {
            params.mode = normalizedMode;
          }
          if (stripeCardNumber?.trim()) {
            params.stripeCardNumber = stripeCardNumber.trim();
          }
          if (stripeExpMonth?.trim()) {
            params.stripeExpMonth = stripeExpMonth.trim();
          }
          if (stripeExpYear?.trim()) {
            params.stripeExpYear = stripeExpYear.trim();
          }
          if (stripeCvc?.trim()) {
            params.stripeCvc = stripeCvc.trim();
          }
          if (stripeCardholderName?.trim()) {
            params.stripeCardholderName = stripeCardholderName.trim();
          }
          if (stripePostalCode?.trim()) {
            params.stripePostalCode = stripePostalCode.trim();
          }
          if (stripeCountry?.trim()) {
            params.stripeCountry = stripeCountry.trim();
          }
          const createdRun = await apiCreateRun(templateId, params, otpCode?.trim());
          const createdRunId = extractRunId(createdRun);
          const terminalRun = await pollRunToTerminal({
            runId: createdRunId,
            otpCode: otpCode?.trim(),
            otpProvider: provider,
            senderFilter: otpSenderFilter?.trim(),
            subjectFilter: otpSubjectFilter?.trim(),
            pollTimeoutSeconds: timeout,
            pollIntervalSeconds: interval,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, action, runtime, createdRun, terminalRun },
                  null,
                  2,
                ),
              },
            ],
            isError:
              parseRunStatus(terminalRun) === "failed" ||
              parseRunStatus(terminalRun) === "cancelled",
          };
        }

        if (!runId?.trim()) {
          throw new Error("runId is required for action=resume");
        }
        const resumedRun = await pollRunToTerminal({
          runId,
          otpCode: otpCode?.trim(),
          otpProvider: provider,
          senderFilter: otpSenderFilter?.trim(),
          subjectFilter: otpSubjectFilter?.trim(),
          pollTimeoutSeconds: timeout,
          pollIntervalSeconds: interval,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, action, runtime, run: resumedRun }, null, 2),
            },
          ],
          isError:
            parseRunStatus(resumedRun) === "failed" || parseRunStatus(resumedRun) === "cancelled",
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, action, detail: (error as Error).message },
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

  mcpServer.registerTool(
    "uiq_register_state",
    {
      description: CORE_TOOL_DESCRIPTIONS.registerState,
      inputSchema: {
        sessionId: z.string().optional(),
        flowId: z.string().optional(),
        templateId: z.string().optional(),
        runId: z.string().optional(),
      },
    },
    async ({ sessionId, flowId, templateId, runId }) => {
      try {
        const runtime = await backendRuntimeStatus();
        const sessions = await apiListSessions(30);
        const activeSession = sessionId?.trim()
          ? (sessions.find((s) => readFirstString(s, ["session_id", "sessionId"]) === sessionId) ??
            null)
          : (sessions[0] ?? null);
        const flow = flowId?.trim() ? await apiGetFlow(flowId) : null;
        const template = templateId?.trim() ? await apiGetTemplate(templateId) : null;
        const run = runId?.trim() ? await apiGetRun(runId) : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  runtime,
                  session: activeSession,
                  flow,
                  template,
                  run,
                },
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
              text: JSON.stringify({ ok: false, detail: (error as Error).message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
