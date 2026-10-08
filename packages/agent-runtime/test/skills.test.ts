// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLoader } from '../src/skills.js';

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
