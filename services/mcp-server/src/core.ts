// @ts-nocheck
// 
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMcpResources, registerMcpTools } from "./tools/register-tools.js";

export const server = new McpServer({
  name: "uiq-mcp-server",
  version: "1.0.0",
});

registerMcpTools(server);
registerMcpResources(server);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
