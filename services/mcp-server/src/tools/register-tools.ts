// @ts-nocheck
// 
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveEnabledToolGroups } from "../core/registry.js";
import {
  registerAdvancedApiTools,
  registerCoreApiTools,
} from "./register-tools/register-api-tools.js";
import {
  registerCoreClosedLoopTools,
  registerRegisterTools,
} from "./register-tools/register-closed-loop-tools.js";
import { registerMcpResources as registerMcpResourcesImpl } from "./register-tools/register-resources.js";
import { registerRunTools } from "./register-tools/register-run-tools.js";

export function registerMcpTools(mcpServer: McpServer): void {
  const groups = resolveEnabledToolGroups();
  registerCoreApiTools(mcpServer);
  registerCoreClosedLoopTools(mcpServer);
  registerRunTools(mcpServer, {
    enableAdvanced: groups.has("advanced"),
    enableAnalysis: groups.has("analysis"),
    enableProof: groups.has("proof"),
  });
  if (groups.has("advanced")) {
    registerAdvancedApiTools(mcpServer);
  }
  if (groups.has("register")) {
    registerRegisterTools(mcpServer);
  }
}

export function registerMcpResources(mcpServer: McpServer): void {
  registerMcpResourcesImpl(mcpServer);
}
