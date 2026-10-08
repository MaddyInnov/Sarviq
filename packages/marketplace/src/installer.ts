// SPDX-License-Identifier: Apache-2.0
// Marketplace installer: copies registry entries into the live config
// directory. MCP servers are approval-gated — deny-by-default:
//
//   1. install(mcpEntry) WITHOUT a token throws McpInstallApprovalRequired
//      and reports what approval to request.
//   2. The API layer creates a governance approval for the MCP install;
//      when the user approves it there, the API calls
//      issueMcpApprovalToken(entryId, approvalId) to mint a one-time token.
//   3. install(entry, { mcpApprovalToken }) consumes the token and proceeds.
//
// Tokens are single-use and bound to the entry id. Install targets are
// sanitized to block path traversal.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  MarketplaceBotPayload,
  MarketplaceEntry,
  MarketplaceMcpPayload,
  MarketplaceSkillPayload,
  MarketplaceWorkflowPayload,
} from './registry.js';

export const MCP_INSTALL_TOOL = 'mcp_server_install';

const INSTALL_TOKEN_MARK = '__mcp_install_approval_required__';

/** Thrown when an MCP server install is attempted without an approval token. */
export class McpInstallApprovalRequired extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`MCP server install requires approval: ${entryId}`);
    (this as Error & { code?: string }).code = INSTALL_TOKEN_MARK;
    this.entryId = entryId;
  }
}

export function isMcpInstallApprovalRequired(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === INSTALL_TOKEN_MARK;
}

export interface InstallResult {
  entryId: string;
  kind: string;
  /** Absolute path of the installed artifact. */
  installedPath: string;
  /** True when the install was gated behind an MCP approval. */
  gated: boolean;
  alreadyInstalled: boolean;
}

export interface InstallOptions {
  /** One-time token from issueMcpApprovalToken(); required for MCP servers. */
  mcpApprovalToken?: string;
  /** Overwrite an existing install of the same id. Default false. */
  overwrite?: boolean;
}

const SAFE_ID = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

function safeId(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${what} id: ${id}`);
  return id;
}

/**
 * Writes installed marketplace artifacts under
 * `<targetDir>/installed/{bots,skills,workflows,mcp-servers}`.
 */
export class MarketplaceInstaller {
  private readonly targetDir: string;
  /** entryId → one-time approval tokens pending consumption. */
  private readonly approvalTokens = new Map<string, Set<string>>();

  constructor(targetDir: string) {
    this.targetDir = resolve(targetDir);
  }

  /**
   * Mint a one-time install token for an MCP server entry. The API calls
   * this only after a governance approval for the install is APPROVED.
   * Returns the token (and the approval id it is tied to for audit).
   */
  issueMcpApprovalToken(entryId: string, governanceApprovalId: string): string {
    const id = safeId(entryId, 'entry');
    const token = `mcpok_${randomUUID().replace(/-/g, '')}`;
    let set = this.approvalTokens.get(id);
    if (!set) {
      set = new Set();
      this.approvalTokens.set(id, set);
    }
    set.add(token);
    // Bind the governance approval id into the token record for audit:
    // store as `${token}:${approvalId}` is overkill; the caller logs the
    // pairing. Token itself is opaque.
    void governanceApprovalId;
    return token;
  }

  /** Revoke all pending tokens for an entry (e.g. after a deny). */
  revokeMcpApprovalTokens(entryId: string): void {
    this.approvalTokens.delete(entryId);
  }

  private consumeToken(entryId: string, token: string): void {
    const set = this.approvalTokens.get(entryId);
    if (!set || !set.delete(token)) {
      throw new McpInstallApprovalRequired(entryId);
    }
    if (set.size === 0) this.approvalTokens.delete(entryId);
  }

  private targetPath(kindDir: string, fileName: string): string {
    const dir = join(this.targetDir, 'installed', kindDir);
    mkdirSync(dir, { recursive: true });
    const full = resolve(dir, fileName);
    if (!full.startsWith(dir + sep)) throw new Error(`path traversal blocked: ${fileName}`);
    return full;
  }

  install(entry: MarketplaceEntry, opts: InstallOptions = {}): InstallResult {
    const id = safeId(entry.id, 'entry');
    if (entry.kind === 'mcp-server') {
      if (!opts.mcpApprovalToken) throw new McpInstallApprovalRequired(entry.id);
      this.consumeToken(entry.id, opts.mcpApprovalToken);
    }

    let installedPath: string;
    let content: string;
    switch (entry.kind) {
      case 'bot': {
        const p = entry.payload as MarketplaceBotPayload;
        installedPath = this.targetPath('bots', `${id}.json`);
        content = JSON.stringify(
          {
            id: p.id,
            name: p.name,
            description: p.description,
            systemPrompt: p.systemPrompt,
            provider: p.provider,
            model: p.model,
            skills: p.skills,
            tools: p.tools,
            mcpServers: p.mcpServers,
          },
          null,
          2,
        );
        break;
      }
      case 'skill': {
        const p = entry.payload as MarketplaceSkillPayload;
        installedPath = this.targetPath('skills', `${id}.md`);
        content = p.content;
        break;
      }
      case 'workflow': {
        const p = entry.payload as MarketplaceWorkflowPayload;
        installedPath = this.targetPath('workflows', `${id}.json`);
        content = JSON.stringify(
          { id: p.id, name: p.name, description: p.description, nodes: p.nodes, edges: p.edges },
          null,
          2,
        );
        break;
      }
      case 'mcp-server': {
        const p = entry.payload as MarketplaceMcpPayload;
        installedPath = this.targetPath('mcp-servers', `${id}.json`);
        // Env VALUES are never shipped: the registry only names required
        // env vars. The installer records them as unconfigured placeholders.
        content = JSON.stringify(
          {
            id: p.id,
            label: p.label,
            command: p.command,
            args: p.args,
            env: Object.fromEntries(p.requiredEnv.map((name) => [name, null])),
            description: p.description,
            installedFrom: { entry: entry.id, version: entry.version },
          },
          null,
          2,
        );
        break;
      }
      default:
        throw new Error(`unknown marketplace kind: ${(entry as { kind: string }).kind}`);
    }

    const alreadyInstalled = existsSync(installedPath);
    if (alreadyInstalled && !opts.overwrite) {
      return { entryId: entry.id, kind: entry.kind, installedPath, gated: entry.kind === 'mcp-server', alreadyInstalled: true };
    }
    writeFileSync(installedPath, content, 'utf8');
    return { entryId: entry.id, kind: entry.kind, installedPath, gated: entry.kind === 'mcp-server', alreadyInstalled };
  }

  /** Remove an installed artifact (idempotent). */
  uninstall(kindDir: 'bots' | 'skills' | 'workflows' | 'mcp-servers', id: string): boolean {
    const target = this.targetPath(kindDir, `${safeId(id, 'entry')}.${kindDir === 'skills' ? 'md' : 'json'}`);
    if (!existsSync(target)) return false;
    // Recoverable delete would need a trash dir; MVP: unlink. Callers that
    // need recovery should snapshot first.
    unlinkSync(target);
    return true;
  }
}
