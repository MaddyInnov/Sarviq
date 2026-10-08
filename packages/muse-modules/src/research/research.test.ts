// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import {
  MockSearchTool,
  ResearchStore,
  planResearch,
  synthesizeReport,
  runDeepResearch,
} from './index.js';

describe('deep research pipeline', () => {
  it('planResearch produces a 4-step plan', () => {
    const plan = planResearch('AI agent pricing');
    expect(plan).toHaveLength(4);
    expect(plan[0].n).toBe(1);
    expect(plan.every((s) => s.question.includes('AI agent pricing'))).toBe(true);
  });

  it('planResearch validates the query', () => {
    expect(() => planResearch('  ')).toThrow(ValidationError);
  });

  it('MockSearchTool returns deterministic cited sources offline', () => {
    const tool = new MockSearchTool();
    const a = tool.search('AI agent security');
    const b = tool.search('AI agent security');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), url: expect.any(String) });
  });

  it('synthesizeReport cites sources and flags untrusted content', () => {
    const plan = planResearch('workflows');
    const sources = new MockSearchTool().search('workflows');
    const md = synthesizeReport('workflows', plan, sources);
    expect(md).toContain('# Research: workflows');
    expect(md).toContain('## Sources');
    expect(md).toContain('untrusted');
    for (const s of sources) expect(md).toContain(s.url);
  });

  it('runDeepResearch runs plan → gather → synthesize and persists', async () => {
    const db = new ModuleDb(':memory:');
    const store = new ResearchStore(db);
    const report = await runDeepResearch('SaaS pricing for AI agents', new MockSearchTool(), store);
    expect(report.query).toBe('SaaS pricing for AI agents');
    expect(report.plan).toHaveLength(4);
    expect(report.sources.length).toBeGreaterThan(0);
    expect(report.reportMd).toContain('## Sources');
    expect(store.get(report.id).id).toBe(report.id);
    expect(store.list()).toHaveLength(1);
    expect(() => store.get('nope')).toThrow(NotFoundError);
  });

  it('runDeepResearch works without a store', async () => {
    const report = await runDeepResearch('vector search', new MockSearchTool());
    expect(report.sources.length).toBeGreaterThan(0);
  });
});
