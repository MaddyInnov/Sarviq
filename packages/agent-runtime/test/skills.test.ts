// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from 'node:fs/promises';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SkillLoader, SkillPinStore, createSkillTools } from '../src/skills.js';
import type { SchemaDriftApprovalBroker } from '../src/mcp.js';

async function makeSkillsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-skills-'));
  writeFileSync(
    join(dir, 'demo.md'),
    `---\nname: demo\ndescription: A demo skill for tests\n---\n\n# Demo\n\nBody text here.\n`,
  );
  mkdirSync(join(dir, 'pack'), { recursive: true });
  writeFileSync(
    join(dir, 'pack', 'SKILL.md'),
    `---\ndescription: Packaged skill\n---\n\nPack content.\n`,
  );
  return dir;
}

describe('SkillLoader', () => {
  it('lists skills from .md files and SKILL.md directories', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    expect(loader.list()).toEqual(['demo', 'pack']);
  });

  it('parses frontmatter name/description and body content', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const skill = await loader.load('demo');
    expect(skill.name).toBe('demo');
    expect(skill.description).toBe('A demo skill for tests');
    expect(skill.content).toContain('Body text here.');
    expect(skill.content).not.toContain('---');
  });

  it('loads directory-style skills', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const skill = await loader.load('pack');
    expect(skill.description).toBe('Packaged skill');
    expect(skill.content).toContain('Pack content.');
  });

  it('throws for unknown skills and returns [] for missing dirs', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    await expect(loader.load('nope')).rejects.toThrow(/Skill not found/);
    expect(new SkillLoader('/tmp/agent-runtime-test-no-such-skills').list()).toEqual([]);
  });
});

describe('SkillLoader progressive disclosure', () => {
  it('getSummary returns name+description without full content', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const summary = await loader.getSummary('demo');
    expect(summary).toEqual({ name: 'demo', description: 'A demo skill for tests' });
    expect('content' in summary).toBe(false);
  });

  it('loadFull returns content plus a sha256 of the content', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const full = await loader.loadFull('demo');
    expect(full.content).toContain('Body text here.');
    expect(full.sha256).toBe(createHash('sha256').update(full.content, 'utf8').digest('hex'));
  });

  it('ctor stays backward compatible: pinning off by default, load() still works', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const skill = await loader.load('demo');
    expect(skill.content).toContain('Body text here.');
    expect(typeof skill.sha256).toBe('string');
  });
});

function makeBroker(decision: 'approved' | 'denied'): SchemaDriftApprovalBroker & { requested: number } {
  const broker = {
    requested: 0,
    requestApproval(): string {
      broker.requested += 1;
      return `appr-${broker.requested}`;
    },
    async awaitDecision(): Promise<'approved' | 'denied'> {
      return decision;
    },
  };
  return broker;
}

describe('SkillLoader TOFU pinning', () => {
  it('pins the hash at first loadFull', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-skillpins-'));
    const pinDb = join(dir, 'skill-pins.db');
    const loader = new SkillLoader(await makeSkillsDir(), { pinDbPath: pinDb });
    const full = await loader.loadFull('demo');
    loader.close();
    const store = new SkillPinStore(pinDb);
    expect(store.getPin('demo')?.contentSha256).toBe(full.sha256);
    store.close();
  });

  it('unchanged content does not request approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-skillpins-'));
    const broker = makeBroker('denied');
    const skillsDir = await makeSkillsDir();
    const first = new SkillLoader(skillsDir, { pinDbPath: join(dir, 'skill-pins.db'), approvalBroker: broker });
    await first.loadFull('demo');
    first.close();
    const second = new SkillLoader(skillsDir, { pinDbPath: join(dir, 'skill-pins.db'), approvalBroker: broker });
    await second.loadFull('demo');
    second.close();
    expect(broker.requested).toBe(0);
  });

  it('drift with an approving broker re-pins and returns the new content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-skillpins-'));
    const skillsDir = await makeSkillsDir();
    const pinDb = join(dir, 'skill-pins.db');
    const first = new SkillLoader(skillsDir, { pinDbPath: pinDb });
    const before = await first.loadFull('demo');
    first.close();

    appendFileSync(join(skillsDir, 'demo.md'), '\nDrifted line.\n');
    const broker = makeBroker('approved');
    const second = new SkillLoader(skillsDir, { pinDbPath: pinDb, approvalBroker: broker });
    const after = await second.loadFull('demo');
    second.close();

    expect(broker.requested).toBe(1);
    expect(after.content).toContain('Drifted line.');
    expect(after.sha256).not.toBe(before.sha256);
    const store = new SkillPinStore(pinDb);
    expect(store.getPin('demo')?.contentSha256).toBe(after.sha256);
    store.close();
  });

  it('drift denied (or broker-less) fails closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-skillpins-'));
    const skillsDir = await makeSkillsDir();
    const pinDb = join(dir, 'skill-pins.db');
    const first = new SkillLoader(skillsDir, { pinDbPath: pinDb });
    await first.loadFull('demo');
    first.close();

    appendFileSync(join(skillsDir, 'demo.md'), '\nDrifted line.\n');
    const denied = new SkillLoader(skillsDir, { pinDbPath: pinDb, approvalBroker: makeBroker('denied') });
    await expect(denied.loadFull('demo')).rejects.toThrow(/not approved|failing closed/);
    denied.close();

    const brokerless = new SkillLoader(skillsDir, { pinDbPath: pinDb });
    await expect(brokerless.loadFull('demo')).rejects.toThrow(/failing closed/);
    brokerless.close();
  });
});

describe('createSkillTools', () => {
  it('exposes a read_skill tool that loads full content on demand', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const tools = createSkillTools(loader);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_skill');
    const result = (await tools[0]!.handler({ name: 'demo' }, { sessionId: 's', botId: 'b' })) as {
      name: string;
      content: string;
      sha256: string;
    };
    expect(result.name).toBe('demo');
    expect(result.content).toContain('Body text here.');
    expect(typeof result.sha256).toBe('string');
    loader.close();
  });

  it('rejects a missing name', async () => {
    const loader = new SkillLoader(await makeSkillsDir());
    const tools = createSkillTools(loader);
    await expect(tools[0]!.handler({}, { sessionId: 's', botId: 'b' })).rejects.toThrow(/"name" is required/);
    loader.close();
  });
});
