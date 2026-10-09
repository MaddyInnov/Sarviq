// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '@mvp/workflows';
import { classifyError, scoreFromFindings, scoreTurn, scoreWorkflowRun } from '../src/scorer.js';
import type { HealthFinding } from '../src/types.js';

const NOW = 1_700_000_000_000;

function node(
  status: 'succeeded' | 'failed' | 'pending' | 'running',
  opts: {
    latencyMs?: number;
    error?: string;
    output?: unknown;
    attempts?: number;
  } = {},
) {
  const startedAt = NOW;
  return {
    status,
    startedAt,
    endedAt: opts.latencyMs !== undefined ? startedAt + opts.latencyMs : undefined,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
  };
}

function run(nodeStates: WorkflowRun['nodeStates'], status: WorkflowRun['status'] = 'succeeded'): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    status,
    nodeStates,
    input: null,
    createdAt: NOW,
    updatedAt: NOW + 60_000,
  };
}

describe('scoreFromFindings', () => {
  const f = (severity: HealthFinding['severity']): HealthFinding => ({
    signal: 'errors',
    severity,
    title: 't',
    detail: 'd',
    fix: 'f',
  });
  it('no findings → good', () => expect(scoreFromFindings([])).toBe('good'));
  it('one warning → needs-work', () => expect(scoreFromFindings([f('warning')])).toBe('needs-work'));
  it('two warnings → needs-work', () =>
    expect(scoreFromFindings([f('warning'), f('warning')])).toBe('needs-work'));
  it('one critical → poor', () => expect(scoreFromFindings([f('critical')])).toBe('poor'));
  it('two criticals → poor', () =>
    expect(scoreFromFindings([f('critical'), f('critical')])).toBe('poor'));
  it('infos alone stay good', () =>
    expect(scoreFromFindings([f('info'), f('info')])).toBe('good'));
});

describe('scoreWorkflowRun', () => {
  it('clean run → good with no findings', () => {
    const h = scoreWorkflowRun(
      run({ a: node('succeeded', { latencyMs: 1000, output: 'ok' }), b: node('succeeded', { latencyMs: 1200, output: 'ok2' }) }),
    );
    expect(h.score).toBe('good');
    expect(h.findings).toHaveLength(0);
    expect(h.failedNodes).toBe(0);
    expect(h.latencyMs).toBe(60_000);
  });

  it('failed run with timeout error → poor, timeout diagnosis + backoff fix', () => {
    const h = scoreWorkflowRun(
      run({ a: node('failed', { latencyMs: 30_000, error: 'request timed out after 30s' }) }, 'failed'),
    );
    expect(h.score).toBe('poor');
    expect(h.failedNodes).toBe(1);
    const titles = h.findings.map((f) => f.title);
    expect(titles).toContain('Step hit a timeout');
    const timeoutFinding = h.findings.find((f) => f.title === 'Step hit a timeout')!;
    expect(timeoutFinding.severity).toBe('critical');
    expect(timeoutFinding.fix).toMatch(/backoff/i);
    expect(h.findings.some((f) => f.title.startsWith('Run failed'))).toBe(true);
  });

  it('classifies rate-limit, auth, denied, network, and config errors', () => {
    expect(classifyError('429 Too Many Requests').fix).toMatch(/backoff/i);
    expect(classifyError('401 unauthorized: invalid api key').title).toMatch(/credentials/i);
    expect(classifyError('tool call denied by policy').title).toMatch(/denied/i);
    expect(classifyError('fetch failed: ECONNREFUSED').title).toMatch(/network/i);
    expect(classifyError('agent node x: config.botId is required').title).toMatch(/misconfigured/i);
  });

  it('step retried 3× → needs-work with retry finding and fix', () => {
    const h = scoreWorkflowRun(
      run({
        a: node('succeeded', { latencyMs: 5000, output: 'ok', attempts: 3 }),
        b: node('succeeded', { latencyMs: 1000, output: 'ok' }),
      }),
    );
    expect(h.score).toBe('needs-work');
    const retry = h.findings.find((f) => f.signal === 'retries')!;
    expect(retry).toBeDefined();
    expect(retry.title).toContain('3×');
    expect(retry.fix).toMatch(/backoff/i);
    expect(retry.nodeId).toBe('a');
  });

  it('HTTP 500 output → critical finding even when the node did not throw', () => {
    const h = scoreWorkflowRun(run({ a: node('succeeded', { latencyMs: 2000, output: { status: 503, body: 'x' } }) }));
    const http = h.findings.find((f) => f.signal === 'http-status')!;
    expect(http.severity).toBe('critical');
    expect(http.title).toContain('503');
  });

  it('latency outlier vs run median → warning', () => {
    const h = scoreWorkflowRun(
      run({
        a: node('succeeded', { latencyMs: 1000, output: 'ok' }),
        b: node('succeeded', { latencyMs: 1000, output: 'ok' }),
        c: node('succeeded', { latencyMs: 20_000, output: 'ok' }),
      }),
    );
    const slow = h.findings.find((f) => f.signal === 'latency')!;
    expect(slow).toBeDefined();
    expect(slow.nodeId).toBe('c');
    expect(slow.severity).toBe('warning');
  });

  it('token bloat vs baseline → warning with fix', () => {
    const h = scoreWorkflowRun(
      run({ a: node('succeeded', { latencyMs: 1000, output: 'ok' }) }),
      { totalTokens: 25_000, baselines: { p50Tokens: 8000 } },
    );
    const bloat = h.findings.find((f) => f.signal === 'token-bloat')!;
    expect(bloat).toBeDefined();
    expect(bloat.fix).toMatch(/context/i);
  });

  it('no token bloat when near baseline', () => {
    const h = scoreWorkflowRun(
      run({ a: node('succeeded', { latencyMs: 1000, output: 'ok' }) }),
      { totalTokens: 9000, baselines: { p50Tokens: 8000 } },
    );
    expect(h.findings.some((f) => f.signal === 'token-bloat')).toBe(false);
  });

  it('empty successful output → info finding', () => {
    const h = scoreWorkflowRun(run({ a: node('succeeded', { latencyMs: 1000, output: '' }) }));
    const info = h.findings.find((f) => f.signal === 'empty-output')!;
    expect(info.severity).toBe('info');
    expect(h.score).toBe('good');
  });
});

describe('scoreTurn', () => {
  it('clean turn → good', () => {
    const h = scoreTurn({ botId: 'b1', latencyMs: 4000, totalTokens: 1200, errored: false });
    expect(h.score).toBe('good');
    expect(h.findings).toHaveLength(0);
  });

  it('errored turn → poor with classified diagnosis', () => {
    const h = scoreTurn({
      botId: 'b1',
      latencyMs: 2000,
      totalTokens: 300,
      errored: true,
      errorMessage: '429 rate limit exceeded',
    });
    expect(h.score).toBe('poor');
    expect(h.findings[0].title).toMatch(/rate limit/i);
    expect(h.findings[0].fix).toMatch(/backoff/i);
  });

  it('tool retry storm → warning with fix', () => {
    const h = scoreTurn({ botId: 'b1', latencyMs: 20_000, totalTokens: 5000, errored: false, toolRetries: 4 });
    const retry = h.findings.find((f) => f.signal === 'retries')!;
    expect(retry.title).toContain('4×');
    expect(h.score).toBe('needs-work');
  });

  it('slow turn vs baseline → latency warning', () => {
    const h = scoreTurn(
      { botId: 'b1', latencyMs: 90_000, totalTokens: 2000, errored: false },
      { baselines: { p50LatencyMs: 10_000 } },
    );
    expect(h.findings.some((f) => f.signal === 'latency')).toBe(true);
  });

  it('token bloat vs baseline → warning', () => {
    const h = scoreTurn(
      { botId: 'b1', latencyMs: 5000, totalTokens: 30_000, errored: false },
      { baselines: { p50Tokens: 5000 } },
    );
    expect(h.findings.some((f) => f.signal === 'token-bloat')).toBe(true);
  });

  it('empty response → warning', () => {
    const h = scoreTurn({ botId: 'b1', latencyMs: 3000, totalTokens: 800, errored: false, emptyResponse: true });
    expect(h.findings.some((f) => f.signal === 'empty-output')).toBe(true);
  });
});
