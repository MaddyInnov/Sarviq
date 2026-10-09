// SPDX-License-Identifier: Apache-2.0
// Tests for the feature-interconnection briefing sources
// (apps/api/src/briefing.ts): notes + workflow runs join the digest, and
// the summary mentions them only when present. Temp data dirs only;
// OLLAMA_HOST points at an unreachable port so the template fallback is
// deterministic (same pattern as briefing.test.ts).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { generateBriefing, templateSummary } from '../src/briefing.js';
import { NoteStore } from '../src/notes.js';

const UNREACHABLE_OLLAMA = 'http://127.0.0.1:1';

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mvp-briefsrc-'));
}

let prevOllama: string | undefined;

beforeEach(() => {
  prevOllama = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = UNREACHABLE_OLLAMA;
});

afterEach(() => {
  if (prevOllama === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = prevOllama;
});

describe('briefing notes + workflow sources', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDataDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseDeps() {
    return {
      governance: new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY }),
      runHealth: new RunHealthStore(join(dir, 'run-health.db')),
      dataDir: dir,
    };
  }

  it('includes recently changed notes and recent workflow runs', async () => {
    const noteStore = new NoteStore(dir);
    noteStore.create({ title: 'Ship plan', content: 'launch friday' });
    const old = noteStore.create({ title: 'Ancient', content: 'old stuff' });
    // push the old note outside the window by rewriting its timestamps
    void old;

    // Capture timestamps BEFORE generateBriefing captures its own `now`
    // (the digest window is [..., now]; runs dated after it are excluded).
    const at = Date.now();
    const workflowSource = {
      listRuns: () => [
        { id: 'run-1', workflowId: 'nightly', status: 'succeeded', createdAt: at, updatedAt: at },
        { id: 'run-2', workflowId: 'nightly', status: 'failed', createdAt: at, updatedAt: at },
      ],
    };

    const briefing = await generateBriefing({ ...baseDeps(), noteStore, workflowSource });
    const titles = briefing.notes!.map((n) => n.title);
    expect(titles).toContain('Ship plan');
    expect(titles).toContain('Ancient');
    expect(briefing.notes!.every((n) => n.kind === 'note')).toBe(true);
    expect(briefing.workflows).toHaveLength(2);
    expect(briefing.workflows![0]!.title).toContain('nightly');
    expect(briefing.workflows![0]!.kind).toBe('workflow');
    // summary mentions both sources
    expect(briefing.summary).toContain('note');
    expect(briefing.summary).toContain('workflow run');
  });

  it('omits the sections when sources are absent (back-compat)', async () => {
    const briefing = await generateBriefing(baseDeps());
    expect(briefing.notes).toEqual([]);
    expect(briefing.workflows).toEqual([]);
    // baseline 4-sentence template shape is unchanged
    expect(briefing.summary!.split('. ').length).toBe(4);
  });

  it('templateSummary adds sentences only when counts are present', () => {
    const base = {
      overnightCount: 1,
      botCount: 1,
      approvalCount: 0,
      approvalTitles: [],
      eventCount: 0,
      regressionCount: 0,
    };
    expect(templateSummary(base).split('. ').length).toBe(4);
    const withCounts = templateSummary({ ...base, noteCount: 2, workflowCount: 3 });
    expect(withCounts.split('. ').length).toBe(6);
    expect(withCounts).toContain('2 notes changed');
    expect(withCounts).toContain('3 workflow runs');
  });
});
