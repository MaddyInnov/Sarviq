// SPDX-License-Identifier: Apache-2.0
// AgentTeams — a coordinator bot that schedules multiple expert member bots
// on multi-step work (Octop AgentTeams parity).
//
// The team itself is a persistent record (SQLite). A team run is a single
// coordinator turn: the coordinator breaks the task into steps and assigns
// each step to the best-fit member via the `delegate` tool's `bot` param.
// Members get scoped subtasks; the coordinator synthesizes the final answer.
// All delegation flows through the normal governance path (delegate is
// approval-gated; children inherit the policy).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = process.getBuiltinModule('node:sqlite');

export interface Team {
  id: string;
  name: string;
  coordinatorBotId: string;
  memberBotIds: string[];
  createdAt: number;
}

export type TeamRunStatus = 'running' | 'done' | 'failed';

export interface TeamRun {
  id: string;
  teamId: string;
  task: string;
  status: TeamRunStatus;
  /** Steps observed so far: { memberBotId, summary, done }. */
  steps: TeamStep[];
  result?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface TeamStep {
  memberBotId: string;
  memberName: string;
  task: string;
  done: boolean;
  summary?: string;
}

export interface TeamMemberInfo {
  id: string;
  name: string;
  description: string;
}

interface TeamRow {
  id: string;
  name: string;
  coordinator_bot_id: string;
  member_bot_ids_json: string;
  created_at: number;
}

interface TeamRunRow {
  id: string;
  team_id: string;
  task: string;
  status: string;
  steps_json: string;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

function rowToTeam(r: TeamRow): Team {
  return {
    id: r.id,
    name: r.name,
    coordinatorBotId: r.coordinator_bot_id,
    memberBotIds: JSON.parse(r.member_bot_ids_json) as string[],
    createdAt: r.created_at,
  };
}

function rowToRun(r: TeamRunRow): TeamRun {
  return {
    id: r.id,
    teamId: r.team_id,
    task: r.task,
    status: r.status as TeamRunStatus,
    steps: JSON.parse(r.steps_json) as TeamStep[],
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
  };
}

/**
 * Build the coordinator's system-level prompt for a team run. The
 * coordinator sees the full roster and assigns each step to the best-fit
 * member via `delegate` with the `bot` parameter.
 */
export function buildCoordinatorPrompt(args: {
  teamName: string;
  coordinatorName: string;
  members: TeamMemberInfo[];
  task: string;
}): string {
  const { teamName, coordinatorName, members, task } = args;
  const roster = members
    .map((m) => `- ${m.id} ("${m.name}"): ${m.description || 'general-purpose member'}`)
    .join('\n');
  return [
    `You are ${coordinatorName}, the coordinator of the agent team "${teamName}".`,
    '',
    'Your job: break the task below into concrete steps and assign each step to the best-fit team member.',
    'Assign a step by calling the `delegate` tool with TWO arguments: "task" (a self-contained subtask with all context the member needs) and "bot" (the member id).',
    'Delegate members do NOT see this conversation, so every delegated task must be fully self-contained.',
    'You may delegate steps in parallel when they are independent. Wait for results, then synthesize ONE final answer for the user.',
    'If a step fails, retry it once with a narrower scope or reassign it before giving up.',
    '',
    'Team roster (use these exact ids in the "bot" argument):',
    roster,
    '',
    'Task:',
    task,
  ].join('\n');
}

export class TeamStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSyncImpl(join(dataDir, 'teams.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        coordinator_bot_id TEXT NOT NULL,
        member_bot_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_team_runs_team ON team_runs (team_id, created_at DESC);
    `);
  }

  createTeam(name: string, coordinatorBotId: string, memberBotIds: string[]): Team {
    const team: Team = {
      id: randomUUID(),
      name: name.trim().slice(0, 120) || 'Untitled team',
      coordinatorBotId,
      memberBotIds: [...new Set(memberBotIds)],
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO teams (id, name, coordinator_bot_id, member_bot_ids_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(team.id, team.name, team.coordinatorBotId, JSON.stringify(team.memberBotIds), team.createdAt);
    return team;
  }

  getTeam(id: string): Team | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as unknown as TeamRow | undefined;
    return row ? rowToTeam(row) : undefined;
  }

  listTeams(): Team[] {
    const rows = this.db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all() as unknown as TeamRow[];
    return rows.map(rowToTeam);
  }

  deleteTeam(id: string): boolean {
    const r = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM team_runs WHERE team_id = ?').run(id);
    return r.changes > 0;
  }

  startRun(teamId: string, task: string): TeamRun {
    const run: TeamRun = {
      id: randomUUID(),
      teamId,
      task,
      status: 'running',
      steps: [],
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO team_runs (id, team_id, task, status, steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(run.id, run.teamId, run.task, run.status, '[]', run.createdAt);
    return run;
  }

  updateRun(id: string, patch: { status?: TeamRunStatus; steps?: TeamStep[]; result?: string; error?: string }): TeamRun | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    const next: TeamRun = {
      ...run,
      status: patch.status ?? run.status,
      steps: patch.steps ?? run.steps,
      result: patch.result ?? run.result,
      error: patch.error ?? run.error,
      finishedAt: patch.status === 'done' || patch.status === 'failed' ? Date.now() : run.finishedAt,
    };
    this.db
      .prepare(
        'UPDATE team_runs SET status = ?, steps_json = ?, result = ?, error = ?, finished_at = ? WHERE id = ?',
      )
      .run(next.status, JSON.stringify(next.steps), next.result ?? null, next.error ?? null, next.finishedAt ?? null, id);
    return next;
  }

  getRun(id: string): TeamRun | undefined {
    const row = this.db.prepare('SELECT * FROM team_runs WHERE id = ?').get(id) as unknown as TeamRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(teamId: string, limit = 20): TeamRun[] {
    const rows = this.db
      .prepare('SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(teamId, limit) as unknown as TeamRunRow[];
    return rows.map(rowToRun);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Team directory + actor enrichment
//
// A lightweight people directory for the team: human collaborators (names,
// handles, emails) with roles and relationships. When team events are
// rendered/returned, event actors are matched against the directory and
// enriched with { role, team, relationship } where matched; unmatched actors
// pass through unchanged.
//
// Matching (normalization only — no network, no paid APIs):
// - handle: exact match, case-insensitive, '@' prefix optional on either side
// - email:  exact match, case-insensitive
// - name:   exact match, case-insensitive
// ---------------------------------------------------------------------------

export interface TeamDirectoryEntry {
  id: string;
  name: string;
  handle?: string;
  email?: string;
  role?: string;
  team?: string;
  timezone?: string;
  notes?: string;
  /**
   * Relationship to the team/user (e.g. "manager", "report", "stakeholder",
   * "client"). Attached by enrichActor alongside role/team when set.
   */
  relationship?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamDirectoryMemberInput {
  name: string;
  handle?: string;
  email?: string;
  role?: string;
  team?: string;
  timezone?: string;
  notes?: string;
  relationship?: string;
}

/** An event actor: a bare string (name/handle/email) or a small actor object. */
export type TeamActor = string | { name?: string; handle?: string; email?: string };

/** An actor enriched with directory data (only attached fields are set). */
export interface EnrichedActor {
  /** The actor as supplied (stringified). */
  actor: string;
  name?: string;
  handle?: string;
  email?: string;
  role?: string;
  team?: string;
  relationship?: string;
}

const DIRECTORY_FILE = 'team-directory.json';
const DIRECTORY_MAX_LEN = 120;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dirCleanString(value: unknown, field: string, maxLen = DIRECTORY_MAX_LEN): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`directory member "${field}" must be a string`);
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length > maxLen) throw new Error(`directory member "${field}" must be at most ${maxLen} chars`);
  return clean;
}

function isDirectoryEntry(v: unknown): v is TeamDirectoryEntry {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string';
}

export class TeamDirectoryStore {
  private readonly filePath: string;
  private readonly members: Map<string, TeamDirectoryEntry> = new Map();

  constructor(dataDir: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, DIRECTORY_FILE);
    try {
      const raw: string = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { members?: unknown }).members)) {
        for (const m of (parsed as { members: unknown[] }).members) {
          if (isDirectoryEntry(m) && !this.members.has(m.id)) this.members.set(m.id, { ...m });
        }
      }
    } catch {
      // Missing or corrupt file: start empty (corrupt file is left for
      // manual recovery; we never overwrite it until the next mutation).
    }
  }

  /** Absolute path of the backing JSON file (for debugging/tests). */
  path(): string {
    return this.filePath;
  }

  private save(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renameSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, members: [...this.members.values()] }, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  listMembers(): TeamDirectoryEntry[] {
    return [...this.members.values()]
      .map((m) => ({ ...m }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getMember(id: string): TeamDirectoryEntry | undefined {
    const m = this.members.get(id);
    return m ? { ...m } : undefined;
  }

  addMember(input: TeamDirectoryMemberInput): TeamDirectoryEntry {
    const name = dirCleanString(input.name, 'name');
    if (!name) throw new Error('directory member "name" is required');
    const now = Date.now();
    const member: TeamDirectoryEntry = {
      id: randomUUID(),
      name,
      handle: dirCleanString(input.handle, 'handle'),
      email: dirCleanString(input.email, 'email'),
      role: dirCleanString(input.role, 'role'),
      team: dirCleanString(input.team, 'team'),
      timezone: dirCleanString(input.timezone, 'timezone'),
      notes: dirCleanString(input.notes, 'notes', 500),
      relationship: dirCleanString(input.relationship, 'relationship'),
      createdAt: now,
      updatedAt: now,
    };
    this.members.set(member.id, member);
    this.save();
    return { ...member };
  }

  updateMember(id: string, patch: Partial<TeamDirectoryMemberInput>): TeamDirectoryEntry | undefined {
    const current = this.members.get(id);
    if (!current) return undefined;
    const next: TeamDirectoryEntry = { ...current };
    if (patch.name !== undefined) {
      const name = dirCleanString(patch.name, 'name');
      if (!name) throw new Error('directory member "name" must be a non-empty string');
      next.name = name;
    }
    for (const key of ['handle', 'email', 'role', 'team', 'timezone', 'relationship'] as const) {
      if (patch[key] !== undefined) next[key] = dirCleanString(patch[key], key);
    }
    if (patch.notes !== undefined) next.notes = dirCleanString(patch.notes, 'notes', 500);
    next.updatedAt = Date.now();
    this.members.set(id, next);
    this.save();
    return { ...next };
  }

  deleteMember(id: string): boolean {
    const existed = this.members.delete(id);
    if (existed) this.save();
    return existed;
  }

  /** Find a directory entry by handle (exact, case-insensitive, '@' optional). */
  findByHandle(handle: string): TeamDirectoryEntry | undefined {
    const needle = handle.trim().replace(/^@+/, '').toLowerCase();
    if (!needle) return undefined;
    for (const m of this.members.values()) {
      if (m.handle && m.handle.trim().replace(/^@+/, '').toLowerCase() === needle) {
        return { ...m };
      }
    }
    return undefined;
  }

  /** Find a directory entry by email (exact, case-insensitive). */
  findByEmail(email: string): TeamDirectoryEntry | undefined {
    const needle = email.trim().toLowerCase();
    if (!needle) return undefined;
    for (const m of this.members.values()) {
      if (m.email && m.email.trim().toLowerCase() === needle) return { ...m };
    }
    return undefined;
  }

  /** Find a directory entry by name (exact, case-insensitive). */
  findByName(name: string): TeamDirectoryEntry | undefined {
    const needle = name.trim().toLowerCase();
    if (!needle) return undefined;
    for (const m of this.members.values()) {
      if (m.name.trim().toLowerCase() === needle) return { ...m };
    }
    return undefined;
  }
}

function entryToEnriched(actor: string, entry: TeamDirectoryEntry): EnrichedActor {
  const enriched: EnrichedActor = { actor };
  if (entry.name) enriched.name = entry.name;
  if (entry.handle) enriched.handle = entry.handle;
  if (entry.email) enriched.email = entry.email;
  if (entry.role) enriched.role = entry.role;
  if (entry.team) enriched.team = entry.team;
  if (entry.relationship) enriched.relationship = entry.relationship;
  return enriched;
}

/**
 * Match an event actor against the team directory and attach
 * { role, team, relationship } (plus name/handle/email) where matched.
 * Unmatched actors are returned unchanged (same shape as the input).
 *
 * Matching order: handle exact (case-insensitive) → email exact
 * (case-insensitive) → name exact (case-insensitive). Bare strings starting
 * with '@' are treated as handles; strings containing '@' as emails.
 */
export function enrichActor(
  actor: TeamActor,
  dir: TeamDirectoryStore | TeamDirectoryEntry[],
): TeamActor | EnrichedActor {
  const entries: TeamDirectoryEntry[] = Array.isArray(dir) ? dir : dir.listMembers();
  const lookup = {
    byHandle: (h: string) =>
      entries.find((m) => m.handle?.trim().replace(/^@+/, '').toLowerCase() === h.trim().replace(/^@+/, '').toLowerCase()),
    byEmail: (e: string) =>
      entries.find((m) => m.email?.trim().toLowerCase() === e.trim().toLowerCase()),
    byName: (n: string) =>
      entries.find((m) => m.name.trim().toLowerCase() === n.trim().toLowerCase()),
  };

  const matchString = (s: string): TeamDirectoryEntry | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    if (t.startsWith('@')) return lookup.byHandle(t);
    if (EMAIL_PATTERN.test(t)) return lookup.byEmail(t);
    // Bare name/handle: try handle, then email, then name.
    return lookup.byHandle(t) ?? lookup.byEmail(t) ?? lookup.byName(t);
  };

  if (typeof actor === 'string') {
    const entry = matchString(actor);
    return entry ? entryToEnriched(actor, entry) : actor;
  }
  const { name, handle, email } = actor;
  const entry =
    (handle ? lookup.byHandle(handle) : undefined) ??
    (email ? lookup.byEmail(email) : undefined) ??
    (name ? lookup.byName(name) : undefined);
  if (!entry) return actor;
  const label = name ?? handle ?? email ?? '';
  return { ...actor, ...entryToEnriched(label, entry) };
}

/** A TeamStep with its actor enriched against the directory (for API rendering). */
export type EnrichedTeamStep = TeamStep & { actor: TeamActor | EnrichedActor };

/** A TeamRun whose steps carry enriched actors (for API rendering). */
export type TeamRunWithActors = Omit<TeamRun, 'steps'> & { steps: EnrichedTeamStep[] };

/**
 * Return a copy of the run with every step's actor enriched against the
 * directory. Unmatched step actors pass through unchanged.
 */
export function withEnrichedRunActors(
  run: TeamRun,
  dir: TeamDirectoryStore | TeamDirectoryEntry[],
): TeamRunWithActors {
  return {
    ...run,
    steps: run.steps.map((step) => ({
      ...step,
      actor: enrichActor(step.memberName, dir),
    })),
  };
}
