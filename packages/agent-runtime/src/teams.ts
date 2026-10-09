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
