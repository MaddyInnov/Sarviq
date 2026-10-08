// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { BrowserAutomation, MockBrowserDriver } from './index.js';

describe('BrowserAutomation approval gating', () => {
  let db: ModuleDb;
  let automation: BrowserAutomation;

  beforeEach(() => {
    db = new ModuleDb(':memory:');
    automation = new BrowserAutomation(db, new MockBrowserDriver());
  });

  it('request() stages a pending approval without executing', () => {
    const { approvalId, status } = automation.request({ action: 'navigate', url: 'https://example.com' });
    expect(status).toBe('pending');
    expect(automation.get(approvalId).status).toBe('pending');
    expect(automation.get(approvalId).resultJson).toBeNull();
  });

  it('execute() refuses without approval', async () => {
    const { approvalId } = automation.request({ action: 'extract_text' });
    await expect(automation.execute(approvalId)).rejects.toThrow(/requires human approval/);
  });

  it('denied actions can never execute', async () => {
    const { approvalId } = automation.request({ action: 'screenshot' });
    automation.decide(approvalId, 'denied');
    await expect(automation.execute(approvalId)).rejects.toThrow(/denied/);
  });

  it('approved actions execute exactly once', async () => {
    const { approvalId } = automation.request({ action: 'navigate', url: 'https://example.com' });
    automation.decide(approvalId, 'approved');
    const { action, result } = await automation.execute(approvalId);
    expect(action).toBe('navigate');
    expect(result).toMatchObject({ url: 'https://example.com' });
    await expect(automation.execute(approvalId)).rejects.toThrow(/already executed/);
  });

  it('extract_text returns fixture text', async () => {
    const { approvalId } = automation.request({ action: 'extract_text' });
    automation.decide(approvalId, 'approved');
    const { result } = await automation.execute(approvalId);
    expect((result as { text: string }).text).toContain('mock extracted text');
  });

  it('navigate requires an http(s) URL', () => {
    expect(() => automation.request({ action: 'navigate', url: 'ftp://x' })).toThrow(ValidationError);
    expect(() => automation.request({ action: 'navigate' })).toThrow(ValidationError);
  });

  it('double decision is rejected; unknown approval is NotFound', () => {
    const { approvalId } = automation.request({ action: 'screenshot' });
    automation.decide(approvalId, 'approved');
    expect(() => automation.decide(approvalId, 'denied')).toThrow(ValidationError);
    expect(() => automation.get('nope')).toThrow(NotFoundError);
  });

  it('lists approvals by status', () => {
    automation.request({ action: 'navigate', url: 'https://a.example' });
    automation.request({ action: 'screenshot' });
    expect(automation.list('pending')).toHaveLength(2);
    expect(automation.list()).toHaveLength(2);
  });
});
