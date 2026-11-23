#!/usr/bin/env node
// The wuica MCP server on stdio (same as `wuica mcp`).
const { runServer } = await import('../lib/mcp.js');
await runServer();
