#!/usr/bin/env node
/**
 * scode-tools MCP server (Phase 4). Stdio transport — spawned by the coding
 * CLIs via `node <scode>/dist/mcp/server.js` (see `scode tools install`).
 * All logging goes to stderr; stdout is the protocol.
 */
import { appendFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureStateHome, statePaths } from '../config.js';
import { callTool, TOOL_DESCRIPTIONS, TOOL_INPUT_SHAPES, TOOL_NAMES } from './tools.js';

const server = new McpServer({ name: 'scode-tools', version: '0.1.0' });

/** Log every tool call for the Phase 5 dead-tool check. Fire-and-forget: a logging failure never breaks the call. */
async function logToolCall(tool: string, ok: boolean, durationMs: number): Promise<void> {
  try {
    await ensureStateHome();
    await appendFile(statePaths().toolCalls, `${JSON.stringify({ timestamp: new Date().toISOString(), tool, ok, durationMs })}\n`, 'utf-8');
  } catch {
    // Logging is best-effort.
  }
}

for (const name of TOOL_NAMES) {
  server.registerTool(name, {
    title: name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: TOOL_INPUT_SHAPES[name],
  }, async (args: Record<string, unknown>) => {
    const started = Date.now();
    const result = await callTool(name, args ?? {});
    void logToolCall(name, !result.isError, Date.now() - started);
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[scode-tools] MCP server running (stdio): pdf-read, latex-build, file-peek');
