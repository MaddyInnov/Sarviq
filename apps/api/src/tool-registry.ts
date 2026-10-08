// SPDX-License-Identifier: Apache-2.0
// Tool registry assembly: built-in tools plus MCP tools from every configured
// server, as a Map<string, ToolDefinition> (what AgentRuntime expects).
// MCPClient.listTools() already returns fully-wired ToolDefinitions named
// `mcp:<server>:<tool>` (server = the config key in mcp.json, e.g. "fetch");
// they are registered verbatim. A failing MCP connection is
// logged and skipped — the bot keeps working with the remaining tools.

import path from 'node:path';
import { MCPClient, createBuiltInTools } from '@mvp/agent-runtime';
import type { SchemaDriftApprovalBroker, ToolDefinition } from '@mvp/agent-runtime';
import type { McpServerConfig } from './seed.js';

export interface McpConnection {
  server: string;
  tools: string[];
  ok: boolean;
  error?: string;
}

export interface BuiltRegistry {
  registry: Map<string, ToolDefinition>;
  connections: McpConnection[];
  close: () => Promise<void>;
}

export async function buildToolRegistry(opts: {
  workspaceDir: string;
  /** Directory for the TOFU schema-pin database (mcp-pins.db). */
  dataDir: string;
  mcpServers: Record<string, McpServerConfig>;
  /** Broker used to request human approval when an MCP tool's schema drifts. */
  approvalBroker?: SchemaDriftApprovalBroker;
}): Promise<BuiltRegistry> {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of createBuiltInTools({ workspaceDir: opts.workspaceDir })) {
    registry.set(tool.name, tool);
  }

  const connections: McpConnection[] = [];
  const clients: MCPClient[] = [];

  for (const [serverName, serverConfig] of Object.entries(opts.mcpServers)) {
    // serverName becomes the `<server>` segment of `mcp:<server>:<tool>` so
    // governance policy can allowlist per server (mcpServerAllowRule).
    // TOFU schema pinning is enabled (mcp-pins.db): tool schemas are pinned
    // at first connect and any drift requires fresh human approval via the
    // governance broker (fail closed). Drift at boot is awaited with the
    // broker's default timeout — a rare, bounded delay; the tool stays
    // blocked on timeout/deny.
    const client = new MCPClient({
      serverName,
      pinDbPath: path.join(opts.dataDir, 'mcp-pins.db'),
      approvalBroker: opts.approvalBroker,
    });
    try {
      if ('url' in serverConfig && serverConfig.url) {
        await client.connectHttp(serverConfig.url);
      } else if ('command' in serverConfig) {
        await client.connectStdio(serverConfig);
      } else {
        throw new Error('MCP server config needs either "url" or "command"');
      }
      clients.push(client);
      const registered: string[] = [];
      for (const tool of await client.listTools()) {
        if (registry.has(tool.name)) {
          console.warn(
            `[tools] MCP tool name collision for "${tool.name}" from server "${serverName}" — skipping`,
          );
          continue;
        }
        registry.set(tool.name, tool);
        registered.push(tool.name);
      }
      connections.push({ server: serverName, tools: registered, ok: true });
      console.log(`[tools] MCP server "${serverName}" connected: ${registered.length} tool(s)`);
    } catch (err) {
      // Contract: connection failure → log + continue, bot still works.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tools] MCP server "${serverName}" failed to connect: ${message} — continuing without it`);
      connections.push({ server: serverName, tools: [], ok: false, error: message });
      try {
        await client.close();
      } catch {
        // ignore close errors on a failed client
      }
    }
  }

  return {
    registry,
    connections,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
