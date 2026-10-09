// SPDX-License-Identifier: Apache-2.0
// Spaces — user-level contexts (e.g. Work / Personal) sitting above the
// per-bot workspaces. A space carries per-space overrides that apply to a
// run when the run is tagged with that space:
//
//   - modelOverride:     pinned model for the run (call-site model still wins)
//   - apiKeyRef:         vault secret NAME referencing an API key to use for
//                        the run. Only the reference id is ever stored or
//                        returned — raw key values never touch this store,
//                        its JSON file, or any API response.
//   - workspaceOverride: workspace root for the run (same semantics as a
//                        per-bot workspace: relative → <dataDir>/workspaces/<v>,
//                        absolute → must stay inside dataDir)
//   - paused:            when true, new runs in this space are rejected
//                        (HTTP 423 from the API layer)
//
// Persistence: a single JSON file <dataDir>/spaces.json, written atomically
// (temp + rename). The "Default" space (id "default") is always created on
// first load and can never be paused or deleted.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBotWorkspace } from './workspaces.js';

export const DEFAULT_SPACE_ID = 'default';
export const DEFAULT_SPACE_NAME = 'Default';

export interface Space {
  id: string;
  name: string;
  /** Pinned model for runs in this space. Call-site model still wins. */
  modelOverride?: string;
  /**
   * Vault secret NAME holding an API key for runs in this space.
   * This is a reference id only — never a raw key value. API responses
   * carry exactly this reference; raw values are resolved server-side at
   * run time and live in memory only.
   */
  apiKeyRef?: string;
  /** Workspace override for runs in this space (bot-workspace semantics). */
  workspaceOverride?: string;
  /** Paused spaces reject new runs (HTTP 423). The Default space is unpausable. */
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SpacePatch = {
  name?: string | null;
  modelOverride?: string | null;
  apiKeyRef?: string | null;
  workspaceOverride?: string | null;
  paused?: boolean;
};

const SPACES_FILE = 'spaces.json';
const MAX_NAME_LEN = 80;
const MAX_MODEL_LEN = 200;
const API_KEY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class SpaceError extends Error {
  readonly code: 'validation' | 'not-found' | 'protected';
  constructor(code: SpaceError['code'], message: string) {
    super(message);
    this.name = 'SpaceError';
    this.code = code;
  }
}

interface SpacesPayload {
  version: 1;
  spaces: Space[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isValidStoredSpace(v: unknown): v is Space {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.paused === 'boolean' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number'
  );
}

function defaultSpace(now: number): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_NAME,
    paused: false,
    createdAt: now,
    updatedAt: now,
  };
}

export class SpaceStore {
  private readonly filePath: string;
  private readonly dataDir: string;
  private spaces: Map<string, Space>;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, SPACES_FILE);
    this.spaces = new Map();
    this.load();
    // The Default space always exists and is unpausable.
    const existing = this.spaces.get(DEFAULT_SPACE_ID);
    if (!existing) {
      const created = defaultSpace(Date.now());
      this.spaces.set(created.id, created);
      this.save();
    } else if (existing.paused) {
      // Self-heal: persisted state can never leave Default paused.
      this.spaces.set(existing.id, { ...existing, paused: false, updatedAt: Date.now() });
      this.save();
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no file yet — start empty, Default gets created
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.spaces)) return;
      for (const s of parsed.spaces) {
        if (isValidStoredSpace(s) && !this.spaces.has(s.id)) {
          this.spaces.set(s.id, { ...s });
        }
      }
    } catch {
      // Corrupt file: fail open with just the Default space rather than
      // wiping user data (the file is left for manual recovery).
      return;
    }
  }

  private save(): void {
    const payload: SpacesPayload = { version: 1, spaces: [...this.spaces.values()] };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Absolute path of the backing JSON file (for debugging/tests). */
  path(): string {
    return this.filePath;
  }

  /** All spaces, Default first, then by creation time. */
  listSpaces(): Space[] {
    return [...this.spaces.values()].sort((a, b) => {
      if (a.id === DEFAULT_SPACE_ID) return -1;
      if (b.id === DEFAULT_SPACE_ID) return 1;
      return a.createdAt - b.createdAt;
    });
  }

  getSpace(id: string): Space | undefined {
    const s = this.spaces.get(id);
    return s ? { ...s } : undefined;
  }

  /** Resolve by id, falling back to an exact name match (convenience for callers). */
  resolveSpace(idOrName: string): Space | undefined {
    const direct = this.getSpace(idOrName);
    if (direct) return direct;
    const byName = [...this.spaces.values()].find((s) => s.name === idOrName);
    return byName ? { ...byName } : undefined;
  }

  createSpace(name: string): Space {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (!clean) throw new SpaceError('validation', 'space "name" is required');
    if (clean.length > MAX_NAME_LEN) {
      throw new SpaceError('validation', `space "name" must be at most ${MAX_NAME_LEN} chars`);
    }
    const now = Date.now();
    const space: Space = {
      id: randomUUID(),
      name: clean,
      paused: false,
      createdAt: now,
      updatedAt: now,
    };
    this.spaces.set(space.id, space);
    this.save();
    return { ...space };
  }

  updateSpace(id: string, patch: SpacePatch): Space {
    const current = this.spaces.get(id);
    if (!current) throw new SpaceError('not-found', `Unknown space "${id}"`);
    const next: Space = { ...current };

    if (patch.name !== undefined) {
      const clean = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!clean) throw new SpaceError('validation', 'space "name" must be a non-empty string');
      if (clean.length > MAX_NAME_LEN) {
        throw new SpaceError('validation', `space "name" must be at most ${MAX_NAME_LEN} chars`);
      }
      next.name = clean;
    }
    if (patch.modelOverride !== undefined) {
      next.modelOverride = cleanOptionalString(patch.modelOverride, 'modelOverride', MAX_MODEL_LEN);
    }
    if (patch.apiKeyRef !== undefined) {
      const ref = cleanOptionalString(patch.apiKeyRef, 'apiKeyRef', 64);
      if (ref !== undefined && !API_KEY_REF_PATTERN.test(ref)) {
        throw new SpaceError(
          'validation',
          'space "apiKeyRef" must be a vault secret name (letters, digits, _, -; max 64 chars)',
        );
      }
      next.apiKeyRef = ref;
    }
    if (patch.workspaceOverride !== undefined) {
      if (patch.workspaceOverride === null || (typeof patch.workspaceOverride === 'string' && !patch.workspaceOverride.trim())) {
        next.workspaceOverride = undefined;
      } else if (typeof patch.workspaceOverride === 'string') {
        try {
          const v = validateBotWorkspace(patch.workspaceOverride, this.dataDir);
          next.workspaceOverride = v || undefined;
        } catch (err) {
          throw new SpaceError('validation', `invalid workspaceOverride: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        throw new SpaceError('validation', 'space "workspaceOverride" must be a string');
      }
    }
    if (patch.paused !== undefined) {
      if (typeof patch.paused !== 'boolean') {
        throw new SpaceError('validation', 'space "paused" must be a boolean');
      }
      if (patch.paused && id === DEFAULT_SPACE_ID) {
        throw new SpaceError('protected', 'The Default space cannot be paused');
      }
      next.paused = patch.paused;
    }

    next.updatedAt = Date.now();
    this.spaces.set(id, next);
    this.save();
    return { ...next };
  }

  deleteSpace(id: string): boolean {
    if (id === DEFAULT_SPACE_ID) {
      throw new SpaceError('protected', 'The Default space cannot be deleted');
    }
    const existed = this.spaces.delete(id);
    if (existed) this.save();
    return existed;
  }
}

function cleanOptionalString(value: string | null, field: string, maxLen: number): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new SpaceError('validation', `space "${field}" must be a string`);
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > maxLen) {
    throw new SpaceError('validation', `space "${field}" must be at most ${maxLen} chars`);
  }
  return clean;
}
