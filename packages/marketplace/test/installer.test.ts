// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isMcpInstallApprovalRequired,
  MarketplaceInstaller,
  McpInstallApprovalRequired,
} from '../src/installer.js';
import { MarketplaceRegistry } from '../src/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'registry', 'registry.json');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mkt-inst-test-'));
}

describe('MarketplaceInstaller', () => {
  it('installs bots, skills, and workflows without approval', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const dir = tmp();
    const inst = new MarketplaceInstaller(dir);

    const bot = inst.install(reg.getById('meeting-scribe')!);
    expect(bot.gated).toBe(false);
    expect(existsSync(bot.installedPath)).toBe(true);
    const botJson = JSON.parse(readFileSync(bot.installedPath, 'utf8')) as { id: string };
    expect(botJson.id).toBe('meeting-scribe');

    const skill = inst.install(reg.getById('git-hygiene')!);
    expect(skill.installedPath.endsWith('.md')).toBe(true);
    expect(existsSync(skill.installedPath)).toBe(true);

    const wf = inst.install(reg.getById('standup-writer')!);
    expect(existsSync(wf.installedPath)).toBe(true);
  });

  it('refuses MCP installs without an approval token (deny-by-default)', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const inst = new MarketplaceInstaller(tmp());
    const mcp = reg.getById('postgres-local')!;
    expect(() => inst.install(mcp)).toThrow(McpInstallApprovalRequired);
    try {
      inst.install(mcp);
    } catch (err) {
      expect(isMcpInstallApprovalRequired(err)).toBe(true);
    }
  });

  it('installs MCP servers only with a one-time token', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const dir = tmp();
    const inst = new MarketplaceInstaller(dir);
    const mcp = reg.getById('postgres-local')!;

    const token = inst.issueMcpApprovalToken(mcp.id, 'appr_123');
    const res = inst.install(mcp, { mcpApprovalToken: token });
    expect(res.gated).toBe(true);
    expect(existsSync(res.installedPath)).toBe(true);
    // Env values are never shipped: placeholders only.
    const written = JSON.parse(readFileSync(res.installedPath, 'utf8')) as {
      env: Record<string, null>;
    };
    expect(written.env).toEqual({ POSTGRES_URL: null });

    // Token is single-use: a second install with the same token fails.
    expect(() => inst.install(mcp, { mcpApprovalToken: token })).toThrow(McpInstallApprovalRequired);
  });

  it('reports alreadyInstalled and honors overwrite', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const inst = new MarketplaceInstaller(tmp());
    const skill = reg.getById('git-hygiene')!;
    const first = inst.install(skill);
    expect(first.alreadyInstalled).toBe(false);
    const second = inst.install(skill);
    expect(second.alreadyInstalled).toBe(true);
    const third = inst.install(skill, { overwrite: true });
    expect(third.alreadyInstalled).toBe(true);
    expect(existsSync(third.installedPath)).toBe(true);
  });

  it('blocks unsafe entry ids (path traversal)', () => {
    const inst = new MarketplaceInstaller(tmp());
    const evil = {
      id: '../../evil',
      kind: 'skill',
      name: 'evil',
      version: '1',
      creator: 'x',
      description: 'x',
      license: 'x',
      priceCents: 0,
      tags: [],
      untrusted: true,
      payload: { id: '../../evil', content: 'x' },
    } as never;
    expect(() => inst.install(evil)).toThrow(/unsafe/);
  });

  it('uninstall is idempotent', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const inst = new MarketplaceInstaller(tmp());
    const skill = reg.getById('git-hygiene')!;
    inst.install(skill);
    expect(inst.uninstall('skills', 'git-hygiene')).toBe(true);
    expect(inst.uninstall('skills', 'git-hygiene')).toBe(false);
  });
});
