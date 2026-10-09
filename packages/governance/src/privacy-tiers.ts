// SPDX-License-Identifier: Apache-2.0
// Privacy tiers: 3-level data classification enforced across vault, memory,
// and every cloud-egress path.
//
// ## Tier semantics
//
// - `metadata`: Non-sensitive facts about data, not the data itself — ids,
//   timestamps, counts, token totals, feature names. May travel anywhere:
//   logs, telemetry, prompts, cloud providers. It is the only tier allowed
//   in audit/telemetry payloads by default.
// - `cloud-ok`: User/bot content that MAY be sent to cloud providers (LLM
//   APIs) and other network egress. This is the default for conversational
//   data (chat messages, distilled memory atoms, workflow inputs) — the
//   platform cannot function without sending it to the model provider.
// - `local-only`: MUST NEVER leave the machine. Blocked from all cloud
//   provider calls and network egress; usable only in local processing
//   (local models, local tools, on-disk storage). A single local-only item
//   in an egress payload denies the WHOLE call (fail closed) and writes an
//   audit entry — partial redaction is not attempted because a missed field
//   is a silent leak.
//
// ## Write-time tagging
//
// Every store tags data at write time via `resolveTier(source, override)`:
// the source supplies the default (e.g. vault secrets default to
// `local-only`, memory atoms to `cloud-ok`) and the caller may override
// explicitly. Overrides are deliberate — there is no silent promotion from
// `local-only` to a weaker tier anywhere in the read path.
//
// ## Enforcement points
//
// - Vault: secrets carry a tier (default `local-only`); `EgressGate` denies
//   any cloud egress containing them.
// - Memory: `TieredMemoryStore.recallForPrompt()` excludes `local-only`
//   atoms from cloud prompts by default.
// - Runtime: `AgentRuntime.runTurn()` accepts `egressItems` + `privacyGate`
//   and asserts the gate before every provider.chat call.
// - `EgressGate.assertEgress()` is the shared choke point: deny + audit.

/** Data classification tier. Ordered least → most restrictive. */
export type PrivacyTier = 'metadata' | 'cloud-ok' | 'local-only';

const VALID_TIERS: ReadonlySet<string> = new Set(['metadata', 'cloud-ok', 'local-only']);

/** Rank for comparison: metadata < cloud-ok < local-only. */
export function tierRank(tier: PrivacyTier): number {
  switch (tier) {
    case 'metadata':
      return 0;
    case 'cloud-ok':
      return 1;
    case 'local-only':
      return 2;
  }
}

/** True when `tier` is at most as restrictive as `max` (e.g. cloud-ok ≤ cloud-ok). */
export function tierAtMost(tier: PrivacyTier, max: PrivacyTier): boolean {
  return tierRank(tier) <= tierRank(max);
}

/** True when data at this tier may be sent to a cloud provider / network egress. */
export function allowsCloudEgress(tier: PrivacyTier): boolean {
  return tier !== 'local-only';
}

export function isPrivacyTier(value: unknown): value is PrivacyTier {
  return typeof value === 'string' && VALID_TIERS.has(value);
}

function assertTier(value: unknown, name: string): PrivacyTier {
  if (!isPrivacyTier(value)) {
    throw new Error(`${name} must be one of metadata|cloud-ok|local-only, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Default tier per data source, used when the writer does not override.
 * Secrets stay local by default; conversational content is cloud-bound by
 * necessity; derived facts/metadata are unrestricted.
 */
export const DEFAULT_TIER_BY_SOURCE: Readonly<Record<string, PrivacyTier>> = {
  vault: 'local-only',
  memory: 'cloud-ok',
  chat: 'cloud-ok',
  workflow: 'cloud-ok',
  system: 'metadata',
  telemetry: 'metadata',
};

/**
 * Tag data at write time: explicit override wins, otherwise the source
 * default, otherwise `cloud-ok` for unknown sources. Never throws for
 * unknown sources (fail open to the conversational default); throws for
 * an invalid explicit override.
 */
export function resolveTier(source: string, override?: unknown): PrivacyTier {
  if (override !== undefined) return assertTier(override, 'tier override');
  const def = (DEFAULT_TIER_BY_SOURCE as Record<string, PrivacyTier | undefined>)[source];
  return def ?? 'cloud-ok';
}

/** A single item presented to the egress gate. */
export interface TieredItem {
  /** Stable identifier for audit messages (never a secret value). */
  id?: string;
  tier: PrivacyTier;
}

export interface EgressCheckResult {
  allowed: boolean;
  /** Items whose tier forbids cloud egress (empty when allowed). */
  blocked: TieredItem[];
}

/** Thrown by EgressGate.assertEgress when local-only data would egress. */
export class PrivacyTierDeniedError extends Error {
  readonly blocked: TieredItem[];
  readonly context: Record<string, unknown>;
  constructor(blocked: TieredItem[], context: Record<string, unknown> = {}) {
    const ids = blocked.map((b) => b.id ?? '<untagged>').join(', ');
    super(
      `Privacy tier violation: ${blocked.length} local-only item(s) blocked from cloud egress [${ids}]. ` +
        `Local-only data must never leave the machine.`,
    );
    this.name = 'PrivacyTierDeniedError';
    this.blocked = blocked;
    this.context = context;
  }
}

/** Audit sink for denied egress attempts. Must never receive item contents. */
export type EgressAuditFn = (action: string, detail: Record<string, unknown>) => void;

/**
 * Choke point for every cloud-egress path. `check()` is pure;
 * `assertEgress()` denies fail-closed and writes an audit entry carrying
 * only item ids/tiers — never contents.
 */
export class EgressGate {
  private readonly audit?: EgressAuditFn;

  constructor(audit?: EgressAuditFn) {
    this.audit = audit;
  }

  /** Pure check: which items (if any) forbid cloud egress. */
  check(items: TieredItem[]): EgressCheckResult {
    const blocked = items.filter((i) => !allowsCloudEgress(i.tier));
    return { allowed: blocked.length === 0, blocked };
  }

  /**
   * Fail-closed assertion for a cloud egress (provider call, webhook,
   * external send). Throws PrivacyTierDeniedError and audits when any
   * item is local-only. Audit detail carries ids/tiers only.
   */
  assertEgress(items: TieredItem[], context: Record<string, unknown> = {}): void {
    const { allowed, blocked } = this.check(items);
    if (allowed) return;
    const detail = {
      ...context,
      blocked: blocked.map((b) => ({ id: b.id ?? '<untagged>', tier: b.tier })),
      count: blocked.length,
    };
    try {
      this.audit?.('privacy.egress_denied', detail);
    } catch {
      // Audit must never break the denial.
    }
    throw new PrivacyTierDeniedError(blocked, context);
  }

  /** Convenience: drop every item that may not go to the cloud. */
  filterForCloud<T extends TieredItem>(items: T[]): T[] {
    return items.filter((i) => allowsCloudEgress(i.tier));
  }
}
