// SPDX-License-Identifier: Apache-2.0
// Tests for @mvp/tenancy: role checks deny correctly, tenant isolation leaks
// nothing, viewer PII masking, invite lifecycle, tenantScope helpers.
// Temp sqlite files only — never the shared data dir.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TenantStore,
  applyTenantScope,
  canAct,
  isRole,
  maskForViewer,
  tenantScope,
} from '../src/index.js';

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'tenancy-')), 'tenancy.db');
}

describe('roles', () => {
  it('orders owner > admin > member > viewer', () => {
    expect(canAct('owner', 'viewer')).toBe(true);
    expect(canAct('admin', 'admin')).toBe(true);
    expect(canAct('member', 'admin')).toBe(false);
    expect(canAct('viewer', 'member')).toBe(false);
    expect(canAct('viewer', 'viewer')).toBe(true);
  });

  it('denies by default on unknown or missing roles', () => {
    expect(canAct(undefined, 'viewer')).toBe(false);
    expect(canAct('', 'viewer')).toBe(false);
    expect(canAct('superadmin', 'viewer')).toBe(false);
    expect(canAct('OWNER', 'viewer')).toBe(false); // case-sensitive
  });

  it('validates role values', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('nope')).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe('TenantStore orgs + memberships', () => {
  let db: string;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates an org with the creator as owner', () => {
    const store = new TenantStore(db);
    const org = store.createOrg('Acme', 'alice');
    expect(org.id).toMatch(/^org_/);
    expect(store.getMembership(org.id, 'alice')?.role).toBe('owner');
    expect(store.ownerCount(org.id)).toBe(1);
    expect(store.listOrgsForUser('alice')).toHaveLength(1);
  });

  it('never demotes or removes the last owner', () => {
    const store = new TenantStore(db);
    const org = store.createOrg('Acme', 'alice');
    expect(() => store.setRole(org.id, 'alice', 'member')).toThrow(/last owner/);
    expect(() => store.removeMember(org.id, 'alice')).toThrow(/last owner/);
    // With two owners, one can step down.
    store.addMember(org.id, 'bob', 'owner');
    store.setRole(org.id, 'alice', 'admin');
    expect(store.getMembership(org.id, 'alice')?.role).toBe('admin');
  });

  it('isolates tenants: org B sees none of org A membership', () => {
    const store = new TenantStore(db);
    const a = store.createOrg('A', 'alice');
    const b = store.createOrg('B', 'bob');
    store.addMember(a.id, 'carol', 'member');
    expect(store.listMembers(b.id).map((m) => m.userId)).toEqual(['bob']);
    expect(store.getMembership(b.id, 'alice')).toBeUndefined();
    expect(store.getMembership(b.id, 'carol')).toBeUndefined();
    expect(store.listOrgsForUser('alice').map((o) => o.org.id)).toEqual([a.id]);
  });

  it('rejects bad input', () => {
    const store = new TenantStore(db);
    expect(() => store.createOrg('', 'alice')).toThrow(/name/);
    expect(() => store.createOrg('x', '')).toThrow(/user id/);
    expect(() => store.setRole('org_nope', 'alice', 'member')).toThrow(/unknown member/);
  });
});

describe('TenantStore invites', () => {
  let db: string;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates, lists, accepts, and revokes invites', () => {
    const store = new TenantStore(db);
    const org = store.createOrg('Acme', 'alice');
    const invite = store.createInvite(org.id, 'Bob@Example.com', 'member');
    expect(invite.email).toBe('bob@example.com'); // normalized
    expect(invite.token).toMatch(/^inv_/);
    expect(store.listInvites(org.id)).toHaveLength(1);

    const membership = store.acceptInvite(invite.token, 'bob');
    expect(membership.role).toBe('member');
    expect(membership.orgId).toBe(org.id);
    expect(store.listInvites(org.id)).toHaveLength(0); // single-use
    expect(() => store.acceptInvite(invite.token, 'bob')).toThrow(/invalid or expired/);
  });

  it('rejects expired invites', () => {
    const store = new TenantStore(db);
    const org = store.createOrg('Acme', 'alice');
    const invite = store.createInvite(org.id, 'zed@example.com', 'viewer', -1);
    expect(store.getInviteByToken(invite.token)).toBeUndefined();
    expect(() => store.acceptInvite(invite.token, 'zed')).toThrow(/invalid or expired/);
  });

  it('revokes invites', () => {
    const store = new TenantStore(db);
    const org = store.createOrg('Acme', 'alice');
    store.createInvite(org.id, 'zed@example.com', 'viewer');
    expect(store.revokeInvite(org.id, 'zed@example.com')).toBe(true);
    expect(store.revokeInvite(org.id, 'zed@example.com')).toBe(false);
  });
});

describe('tenantScope', () => {
  it('builds a parameterized filter, never interpolating the tenant id', () => {
    const f = tenantScope('org_123');
    expect(f.where).toBe('"org_id" = ?');
    expect(f.params).toEqual(['org_123']);
    expect(f.where).not.toContain('org_123');
  });

  it('applyTenantScope filters rows by the tenant key', () => {
    const rows = [
      { orgId: 'a', id: 1 },
      { orgId: 'b', id: 2 },
      { orgId: 'a', id: 3 },
    ];
    expect(applyTenantScope(rows, 'a').map((r) => r.id)).toEqual([1, 3]);
    expect(applyTenantScope(rows, 'zzz')).toEqual([]);
  });
});

describe('maskForViewer', () => {
  it('masks emails, phones, and secrets', () => {
    const input = {
      name: 'Alice',
      email: 'alice@example.com',
      contactPhone: '+1 (555) 123-4567',
      apiKey: 'sk-live-123',
      note: 'reached alice@example.com today',
      calls: 3,
    };
    const out = maskForViewer(input);
    expect(out.name).toBe('Alice');
    expect(out.email).toBe('a***@example.com');
    expect(out.contactPhone).toBe('[PHONE MASKED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.note).toContain('a***@example.com');
    expect(out.calls).toBe(3);
    // Input not mutated.
    expect(input.email).toBe('alice@example.com');
    expect(input.apiKey).toBe('sk-live-123');
  });

  it('leaves non-PII values and nested structures alone otherwise', () => {
    const out = maskForViewer({
      id: 'usr_42',
      items: [{ label: 'ok' }],
      maybePhone: 'not a phone',
    });
    expect(out).toEqual({ id: 'usr_42', items: [{ label: 'ok' }], maybePhone: 'not a phone' });
  });

  it('masks secret-like keys even with non-string values', () => {
    expect(maskForViewer({ token: 12345 })).toEqual({ token: '[REDACTED]' });
  });

  it('is cycle-safe', () => {
    const a: Record<string, unknown> = { email: 'x@y.com' };
    a.self = a;
    const out = maskForViewer(a);
    expect(out.email).toBe('x***@y.com');
    expect(out.self).toBe('[CIRCULAR]');
  });
});
