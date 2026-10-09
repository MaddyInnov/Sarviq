// SPDX-License-Identifier: Apache-2.0
// Delegation-policy storage + resolution (workstream C). Pure store tests;
// the gate itself is tested in apps/api (teams-delegation.test.ts).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DELEGATION_POLICY,
  TeamStore,
  isDelegationPolicy,
  resolveDelegationPolicy,
} from '../src/teams.js';

describe('delegation policy', () => {
  let dir: string;
  let store: TeamStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teams-policy-'));
    store = new TeamStore(dir);
  });

  it('defaults to approve-once-per-team on fresh records', () => {
    const team = store.createTeam('T', 'coord', ['a']);
    expect(team.delegationPolicy).toBeUndefined();
    expect(resolveDelegationPolicy(team, 'a')).toBe('approve-once-per-team');
    expect(DEFAULT_DELEGATION_POLICY).toBe('approve-once-per-team');
  });

  it('migrates pre-existing databases (ALTER TABLE guarded)', () => {
    const team = store.createTeam('T', 'coord', ['a']);
    // A second store on the same dataDir re-runs the migration.
    const reopened = new TeamStore(dir);
    const loaded = reopened.getTeam(team.id)!;
    expect(loaded.id).toBe(team.id);
    const updated = reopened.setDelegationPolicy(team.id, 'always-ask');
    expect(updated?.delegationPolicy).toBe('always-ask');
  });

  it('setDelegationPolicy round-trips policy + overrides', () => {
    const team = store.createTeam('T', 'coord', ['a', 'b']);
    const updated = store.setDelegationPolicy(team.id, 'always-ask', { a: 'always-allow' });
    expect(updated?.delegationPolicy).toBe('always-ask');
    expect(updated?.delegationPolicyOverrides).toEqual({ a: 'always-allow' });
    // Persisted across reads.
    const reloaded = store.getTeam(team.id)!;
    expect(reloaded.delegationPolicy).toBe('always-ask');
    expect(reloaded.delegationPolicyOverrides).toEqual({ a: 'always-allow' });
  });

  it('setDelegationPolicy drops invalid override values', () => {
    const team = store.createTeam('T', 'coord', ['a']);
    const updated = store.setDelegationPolicy(team.id, 'always-ask', {
      a: 'always-allow',
      b: 'bogus' as never,
    });
    expect(updated?.delegationPolicyOverrides).toEqual({ a: 'always-allow' });
  });

  it('setDelegationPolicy returns undefined for unknown teams', () => {
    expect(store.setDelegationPolicy('nope', 'always-ask')).toBeUndefined();
  });

  it('resolveDelegationPolicy: override > team policy > default', () => {
    const team = store.createTeam('T', 'coord', ['a', 'b']);
    store.setDelegationPolicy(team.id, 'always-ask', { a: 'always-allow' });
    const loaded = store.getTeam(team.id)!;
    expect(resolveDelegationPolicy(loaded, 'a')).toBe('always-allow'); // override wins
    expect(resolveDelegationPolicy(loaded, 'b')).toBe('always-ask'); // team policy
    expect(resolveDelegationPolicy({ ...loaded, delegationPolicy: undefined, delegationPolicyOverrides: undefined }, 'b')).toBe(
      'approve-once-per-team',
    ); // default
  });

  it('isDelegationPolicy validates the three policies', () => {
    expect(isDelegationPolicy('approve-once-per-team')).toBe(true);
    expect(isDelegationPolicy('always-ask')).toBe(true);
    expect(isDelegationPolicy('always-allow')).toBe(true);
    expect(isDelegationPolicy('sometimes')).toBe(false);
    expect(isDelegationPolicy(undefined)).toBe(false);
    expect(isDelegationPolicy(null)).toBe(false);
  });

  it('delegation grants: record → has → revoke', () => {
    const team = store.createTeam('T', 'coord', ['a']);
    expect(store.hasDelegationGrant(team.id)).toBe(false);
    store.recordDelegationGrant(team.id);
    expect(store.hasDelegationGrant(team.id)).toBe(true);
    // Idempotent re-record.
    store.recordDelegationGrant(team.id);
    expect(store.hasDelegationGrant(team.id)).toBe(true);
    store.revokeDelegationGrant(team.id);
    expect(store.hasDelegationGrant(team.id)).toBe(false);
  });
});
