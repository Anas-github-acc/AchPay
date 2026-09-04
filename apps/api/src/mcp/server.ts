#!/usr/bin/env node
/**
 * The MCP server over stdio: one process, one client, launched as a subprocess
 * by whatever is doing the talking. `pnpm mcp` runs this.
 *
 * The tools live in build.ts, which the HTTP transport in http/mcp-route.ts
 * uses too. Nothing here knows what a tool is.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './build.js';
import { baseUrl } from './api.js';

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the protocol channel; anything human-readable goes to stderr.
process.stderr.write(`agent-storefront MCP server ready (api: ${baseUrl()})\n`);
