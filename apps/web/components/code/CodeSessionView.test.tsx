// SPDX-License-Identifier: Apache-2.0
// Smoke test: CodeSessionView + CodingSessionStrip render without crashing.
// Animation is rAF-driven (not asserted here); the reducer + runtime tests
// cover the event logic, and reduced-motion paths render statically.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CodeSessionView } from './CodeSessionView';
import { CodingSessionStrip } from './CodingSessionStrip';
import type { CodeFileSession } from './useCodeSession';

// rAF/IntersectionObserver/matchMedia don't exist in node — stub them.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  disconnect() {}
});
vi.stubGlobal('matchMedia', () => ({ matches: true })); // reduced-motion: static render

const FILES: CodeFileSession[] = [
  {
    file: 'src/app.ts', botId: 'b1', botName: 'Coder', kind: 'write',
    before: 'const a = 1;\n', after: 'const a = 2;\n', status: 'writing',
    callId: 'c1', updatedAt: 1,
  },
  {
    file: 'README.md', botId: 'b1', botName: 'Coder', kind: 'read',
    before: null, after: '# Hello\n', status: 'done',
    callId: 'c2', updatedAt: 2,
  },
];

describe('CodeSessionView', () => {
  it('renders tabs for every file with bot badges', () => {
    const html = renderToString(
      <CodeSessionView files={FILES} layout="inline" onToggleLayout={() => {}} onClose={() => {}} onFileDone={() => {}} />,
    );
    expect(html).toContain('app.ts');
    expect(html).toContain('README.md');
    expect(html).toContain('Coder');
    expect(html).toContain('Live code session');
    expect(html).toContain('Side panel'); // layout toggle
  });

  it('renders nothing when there are no files', () => {
    const html = renderToString(
      <CodeSessionView files={[]} layout="inline" onToggleLayout={() => {}} onClose={() => {}} onFileDone={() => {}} />,
    );
    expect(html).toBe('');
  });
});

describe('CodingSessionStrip', () => {
  it('renders agents, files and approval actions while active', () => {
    const html = renderToString(
      <CodingSessionStrip
        files={FILES}
        active
        pendingApprovals={[{ approvalId: 'ap1', blockId: 'b1', call: { id: 'c9', name: 'run_command', args: {} } }]}
        onDecide={() => {}}
        onOpenSession={() => {}}
      />,
    );
    expect(html).toContain('Coding');
    expect(html).toContain('Coder');
    expect(html).toContain('README.md'); // one chip per agent, showing its latest file
    expect(html).toContain('2');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
  });

  it('collapses away when no coding turn is active', () => {
    const html = renderToString(
      <CodingSessionStrip files={FILES} active={false} pendingApprovals={[]} onDecide={() => {}} onOpenSession={() => {}} />,
    );
    expect(html).toBe('');
  });
});
