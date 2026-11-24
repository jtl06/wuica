// The remote MCP server: the package's tool table (wuica/mcp: mcpTools, the same names, schemas, handlers and argument
// checks as the stdio server) behind the SDK's low-level Server, which the Streamable HTTP transport needs. The JSON
// Schemas are served as they are (no zod in this file; the SDK uses zod internally, a peer dependency it requires).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { mcpTools, toolListing, callTool, SERVER_INFO, CAPABILITIES, INSTRUCTIONS } from 'wuica/mcp';

// w: the facade bound to a request (Facade.forRequest), as the library's interface
export function createMcpServer(w) {
  const tools = mcpTools(w);
  const server = new Server({ ...SERVER_INFO }, { capabilities: CAPABILITIES, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toolListing) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await callTool(tools, req.params.name, req.params.arguments);
    if (r.error) throw new McpError(r.error.code, r.error.message);
    return r;
  });
  return server;
}
