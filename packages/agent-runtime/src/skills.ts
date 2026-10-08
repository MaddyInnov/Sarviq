// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
}

/**
 * Loads skill definitions from a directory. A skill is either
 * `<skillsDir>/<name>.md` or `<skillsDir>/<name>/SKILL.md`,
 * with YAML frontmatter (name, description) parsed via gray-matter.
 */
export class SkillLoader {
  constructor(private readonly skillsDir: string) {}

  list(): string[] {
    if (!existsSync(this.skillsDir)) return [];
    const names = new Set<string>();
    for (const entry of readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        names.add(entry.name.slice(0, -3));
      } else if (entry.isDirectory() && existsSync(join(this.skillsDir, entry.name, 'SKILL.md'))) {
        names.add(entry.name);
      }
    }
    return [...names].sort();
  }

  async load(name: string): Promise<LoadedSkill> {
    const candidates = [join(this.skillsDir, name, 'SKILL.md'), join(this.skillsDir, `${name}.md`)];
    const file = candidates.find((c) => existsSync(c));
    if (!file) throw new Error(`Skill not found: "${name}" (looked in ${this.skillsDir})`);
    const parsed = matter(readFileSync(file, 'utf8'));
    const data = parsed.data as Record<string, unknown>;
    return {
      name: typeof data.name === 'string' && data.name ? data.name : name,
      description: typeof data.description === 'string' ? data.description : '',
      content: parsed.content.trim(),
    };
  }
}
