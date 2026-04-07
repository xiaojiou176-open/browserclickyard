// @ts-nocheck
// 
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { apiRequest } from "../../core/api-client.js";
import { CORE_TOOL_DESCRIPTIONS } from "./descriptions.js";

type ApiResponse = Awaited<ReturnType<typeof apiRequest>>;

type ToolInputSchema = Record<string, z.ZodTypeAny>;

function formatApiToolResult(res: ApiResponse): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(res.json ?? res.body, null, 2) }],
    isError: !res.ok,
  };
}

function registerApiTool<TInput extends Record<string, unknown>>(
  mcpServer: McpServer,
  name: string,
  description: string,
  inputSchema: ToolInputSchema,
  handler: (input: TInput) => Promise<ApiResponse>,
): void {
  mcpServer.registerTool(name, { description, inputSchema }, async (input) =>
    formatApiToolResult(await handler(input as TInput)),
  );
}

export function registerAdvancedApiTools(mcpServer: McpServer): void {
  registerApiTool(
    mcpServer,
    "uiq_api_automation_commands",
    "GET /api/automation/commands",
    {},
    async () => {
      return apiRequest("/api/automation/commands");
    },
  );

  registerApiTool(
    mcpServer,
    "uiq_api_automation_tasks",
    "GET /api/automation/tasks",
    {
      status: z.string().optional(),
      commandId: z.string().optional(),
      limit: z.number().int().optional(),
    },
    async ({ status, commandId, limit }) => {
      const qp = new URLSearchParams();
      if (status) {
        qp.set("status", String(status));
      }
      if (commandId) {
        qp.set("command_id", String(commandId));
      }
      if (limit !== undefined) {
        qp.set("limit", String(limit));
      }
      return apiRequest(`/api/automation/tasks${qp.size ? `?${qp.toString()}` : ""}`);
    },
  );

  registerApiTool(
    mcpServer,
    "uiq_api_automation_task",
    "GET /api/automation/tasks/{taskId}",
    { taskId: z.string() },
    async ({ taskId }) => apiRequest(`/api/automation/tasks/${encodeURIComponent(String(taskId))}`),
  );

  registerApiTool(
    mcpServer,
    "uiq_api_automation_run",
    "POST /api/automation/run",
    { commandId: z.string(), env: z.record(z.string(), z.string()).optional() },
    async ({ commandId, env }) => {
      return apiRequest("/api/automation/run", {
        method: "POST",
        body: JSON.stringify({ command: commandId, ...(env ? { env } : {}) }),
      });
    },
  );

  registerApiTool(
    mcpServer,
    "uiq_api_automation_cancel",
    "POST /api/automation/tasks/{taskId}/cancel",
    { taskId: z.string() },
    async ({ taskId }) =>
      apiRequest(`/api/automation/tasks/${encodeURIComponent(String(taskId))}/cancel`, {
        method: "POST",
      }),
  );
}

export function registerCoreApiTools(mcpServer: McpServer): void {
  registerApiTool(
    mcpServer,
    "uiq_api_flows",
    CORE_TOOL_DESCRIPTIONS.apiFlows,
    {
      action: z.enum(["list", "get", "import_latest", "create", "update"]),
      flowId: z.string().optional(),
      limit: z.number().int().optional(),
      sessionId: z.string().optional(),
      startUrl: z.string().optional(),
      sourceEventCount: z.number().int().optional(),
      steps: z.array(z.record(z.string(), z.unknown())).optional(),
    },
    async ({ action, flowId, limit, sessionId, startUrl, sourceEventCount, steps }) => {
      if (action === "list") {
        const qp = new URLSearchParams();
        if (limit !== undefined) {
          qp.set("limit", String(limit));
        }
        return apiRequest(`/api/flows${qp.size ? `?${qp.toString()}` : ""}`);
      }
      if (action === "get") {
        if (!flowId) {
          throw new Error("flowId required for action=get");
        }
        return apiRequest(`/api/flows/${encodeURIComponent(String(flowId))}`);
      }
      if (action === "import_latest") {
        return apiRequest("/api/flows/import-latest", { method: "POST" });
      }
      if (action === "create") {
        if (!String(sessionId ?? "").trim()) {
          throw new Error("sessionId required for action=create");
        }
        if (!String(startUrl ?? "").trim()) {
          throw new Error("startUrl required for action=create");
        }
        return apiRequest("/api/flows", {
          method: "POST",
          body: JSON.stringify({
            session_id: sessionId,
            start_url: startUrl,
            source_event_count: sourceEventCount,
            steps: steps ?? [],
          }),
        });
      }
      if (!flowId) {
        throw new Error("flowId required for action=update");
      }
      if (!startUrl && !steps) {
        throw new Error("startUrl or steps required for action=update");
      }
      return apiRequest(`/api/flows/${encodeURIComponent(String(flowId))}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(startUrl ? { start_url: startUrl } : {}),
          ...(steps ? { steps } : {}),
        }),
      });
    },
  );

  registerApiTool(
    mcpServer,
    "uiq_api_templates",
    CORE_TOOL_DESCRIPTIONS.apiTemplates,
    {
      action: z.enum(["list", "get", "export", "create", "update"]),
      templateId: z.string().optional(),
      limit: z.number().int().optional(),
      flowId: z.string().optional(),
      name: z.string().optional(),
      paramsSchema: z.array(z.record(z.string(), z.unknown())).optional(),
      defaults: z.record(z.string(), z.unknown()).optional(),
      policies: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ action, templateId, limit, flowId, name, paramsSchema, defaults, policies }) => {
      if (action === "list") {
        const qp = new URLSearchParams();
        if (limit !== undefined) {
          qp.set("limit", String(limit));
        }
        return apiRequest(`/api/templates${qp.size ? `?${qp.toString()}` : ""}`);
      }
      if (action === "get") {
        if (!templateId) {
          throw new Error("templateId required for action=get");
        }
        return apiRequest(`/api/templates/${encodeURIComponent(String(templateId))}`);
      }
      if (action === "export") {
        if (!templateId) {
          throw new Error("templateId required for action=export");
        }
        return apiRequest(`/api/templates/${encodeURIComponent(String(templateId))}/export`);
      }
      if (action === "create") {
        if (!String(flowId ?? "").trim()) {
          throw new Error("flowId required for action=create");
        }
        if (!String(name ?? "").trim()) {
          throw new Error("name required for action=create");
        }
        return apiRequest("/api/templates", {
          method: "POST",
          body: JSON.stringify({
            flow_id: flowId,
            name,
            params_schema: paramsSchema ?? [],
            defaults: defaults ?? {},
            policies: policies ?? {},
          }),
        });
      }
      if (!templateId) {
        throw new Error("templateId required for action=update");
      }
      if (!name && !paramsSchema && !defaults && !policies) {
        throw new Error(
          "at least one of name/paramsSchema/defaults/policies required for action=update",
        );
      }
      return apiRequest(`/api/templates/${encodeURIComponent(String(templateId))}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(name ? { name } : {}),
          ...(paramsSchema ? { params_schema: paramsSchema } : {}),
          ...(defaults ? { defaults } : {}),
          ...(policies ? { policies } : {}),
        }),
      });
    },
  );

  registerApiTool(
    mcpServer,
    "uiq_api_runs",
    CORE_TOOL_DESCRIPTIONS.apiRuns,
    {
      action: z.enum(["list", "get", "create", "otp", "cancel"]),
      runId: z.string().optional(),
      limit: z.number().int().optional(),
      templateId: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      otpCode: z.string().optional(),
    },
    async ({ action, runId, limit, templateId, params, otpCode }) => {
      if (action === "list") {
        const qp = new URLSearchParams();
        if (limit !== undefined) {
          qp.set("limit", String(limit));
        }
        return apiRequest(`/api/runs${qp.size ? `?${qp.toString()}` : ""}`);
      }
      if (action === "get") {
        if (!runId) {
          throw new Error("runId required for action=get");
        }
        return apiRequest(`/api/runs/${encodeURIComponent(String(runId))}`);
      }
      if (action === "create") {
        if (!String(templateId ?? "").trim()) {
          throw new Error("templateId required for action=create");
        }
        return apiRequest("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            template_id: templateId,
            params: params ?? {},
            ...(otpCode ? { otp_code: otpCode } : {}),
          }),
        });
      }
      if (action === "otp") {
        if (!runId) {
          throw new Error("runId required for action=otp");
        }
        if (!String(otpCode ?? "").trim()) {
          throw new Error("otpCode required for action=otp");
        }
        return apiRequest(`/api/runs/${encodeURIComponent(String(runId))}/otp`, {
          method: "POST",
          body: JSON.stringify({ otp_code: otpCode }),
        });
      }
      if (!runId) {
        throw new Error("runId required for action=cancel");
      }
      return apiRequest(`/api/runs/${encodeURIComponent(String(runId))}/cancel`, {
        method: "POST",
      });
    },
  );
}
