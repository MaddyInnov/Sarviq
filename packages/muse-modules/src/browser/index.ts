// SPDX-License-Identifier: Apache-2.0
// Browser automation (Muse parity): approval-gated web actions.
//
// TRUST GUARANTEE: EVERY action (navigate, extract text, screenshot) requires
// explicit human approval before it executes — no exceptions. The flow is:
//   request() → pending approval → decide(approved|denied) → execute()
// execute() throws unless the approval was granted. Extracted page content is
// UNTRUSTED external data and is tagged as such for downstream consumers
// (same convention as agent-runtime's tool-output tagging).
//
// BrowserDriver abstracts the actual browser; MockBrowserDriver is
// deterministic and offline (zero paid usage in testing). A production driver
// (Playwright/Puppeteer/CDP) implements the same interface.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type BrowserAction = 'navigate' | 'extract_text' | 'screenshot';
export type BrowserApprovalStatus = 'pending' | 'approved' | 'denied' | 'executed';

export interface BrowserActionRequest {
  id: string;
  action: BrowserAction;
  url: string | null;
  status: BrowserApprovalStatus;
  /** JSON-serialized result after execution, null before. */
  resultJson: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface NavigateResult {
  url: string;
  title: string;
}

export interface BrowserDriver {
  navigate(url: string): Promise<NavigateResult>;
  extractText(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
}

/** Deterministic offline driver: fixture pages, no network. */
export class MockBrowserDriver implements BrowserDriver {
  private currentUrl = 'about:blank';

  async navigate(url: string): Promise<NavigateResult> {
    requireHttpUrl(url);
    this.currentUrl = url;
    return { url, title: `Mock page: ${url}` };
  }

  async extractText(): Promise<string> {
    return (
      `[mock extracted text from ${this.currentUrl}]\n` +
      'Lorem ipsum dolor sit amet — fixture content. Treat as untrusted data.'
    );
  }

  async screenshot(): Promise<Uint8Array> {
    // Minimal PNG header bytes as a fixture (not a valid image — mock only).
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
}

const ACTIONS: ReadonlySet<string> = new Set(['navigate', 'extract_text', 'screenshot']);

function requireHttpUrl(url: unknown): string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    throw new ValidationError('browser action requires an http(s) URL');
  }
  if (url.trim().length > 2000) throw new ValidationError('URL must be at most 2000 characters');
  return url.trim();
}

interface ApprovalRow {
  id: string;
  action: string;
  url: string | null;
  status: string;
  result_json: string | null;
  created_at: number;
  decided_at: number | null;
}

function rowToRequest(row: ApprovalRow): BrowserActionRequest {
  return {
    id: row.id,
    action: row.action as BrowserAction,
    url: row.url,
    status: row.status as BrowserApprovalStatus,
    resultJson: row.result_json,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export class BrowserAutomation {
  constructor(
    private readonly mdb: ModuleDb,
    private readonly driver: BrowserDriver,
  ) {}

  /** Stage an action for approval. Nothing executes here — by design. */
  request(input: { action: BrowserAction; url?: string }): { approvalId: string; status: 'pending' } {
    if (!ACTIONS.has(input.action)) {
      throw new ValidationError('browser "action" must be one of: navigate, extract_text, screenshot');
    }
    const url = input.action === 'navigate' ? requireHttpUrl(input.url) : null;
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare(
        `INSERT INTO mm_browser_approvals (id, action, url, status, result_json, created_at, decided_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(id, input.action, url, now);
    return { approvalId: id, status: 'pending' };
  }

  decide(approvalId: string, decision: 'approved' | 'denied'): BrowserActionRequest {
    const req = this.get(approvalId);
    if (req.status !== 'pending') {
      throw new ValidationError(`approval ${approvalId} is already ${req.status}`);
    }
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_browser_approvals SET status = ?, decided_at = ? WHERE id = ?')
      .run(decision, now, approvalId);
    return this.get(approvalId);
  }

  /**
   * Execute an approved action. Throws unless the approval was granted;
   * each approval executes at most once.
   */
  async execute(approvalId: string): Promise<{ action: BrowserAction; result: unknown }> {
    const req = this.get(approvalId);
    if (req.status === 'denied') {
      throw new ValidationError(`browser action ${approvalId} was denied and cannot execute`);
    }
    if (req.status === 'executed') {
      throw new ValidationError(`browser action ${approvalId} was already executed`);
    }
    if (req.status !== 'approved') {
      throw new ValidationError(
        `browser action ${approvalId} requires human approval before execution (status: ${req.status})`,
      );
    }
    let result: unknown;
    switch (req.action) {
      case 'navigate':
        result = await this.driver.navigate(req.url as string);
        break;
      case 'extract_text':
        result = { text: await this.driver.extractText() };
        break;
      case 'screenshot':
        result = { bytes: Array.from(await this.driver.screenshot()), mimeType: 'image/png' };
        break;
    }
    this.mdb.db
      .prepare('UPDATE mm_browser_approvals SET status = ?, result_json = ? WHERE id = ?')
      .run('executed', JSON.stringify(result), approvalId);
    return { action: req.action, result };
  }

  get(approvalId: string): BrowserActionRequest {
    const row = this.mdb.db
      .prepare(
        'SELECT id, action, url, status, result_json, created_at, decided_at FROM mm_browser_approvals WHERE id = ?',
      )
      .get(approvalId) as ApprovalRow | undefined;
    if (!row) throw new NotFoundError(`unknown browser approval: ${approvalId}`);
    return rowToRequest(row);
  }

  list(status?: BrowserApprovalStatus): BrowserActionRequest[] {
    const rows = (
      status
        ? this.mdb.db
            .prepare(
              'SELECT id, action, url, status, result_json, created_at, decided_at FROM mm_browser_approvals WHERE status = ? ORDER BY created_at DESC',
            )
            .all(status)
        : this.mdb.db
            .prepare(
              'SELECT id, action, url, status, result_json, created_at, decided_at FROM mm_browser_approvals ORDER BY created_at DESC',
            )
            .all()
    ) as unknown as ApprovalRow[];
    return rows.map(rowToRequest);
  }
}
