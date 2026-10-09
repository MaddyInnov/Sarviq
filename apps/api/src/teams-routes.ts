// SPDX-License-Identifier: Apache-2.0
// HTTP routes for AgentTeams.
//
//   POST   /                        → { name, coordinatorBotId, memberBotIds[] }
//   GET    /                        → list teams
//   DELETE /:id                     → delete team (+ runs)
//   POST   /:id/run                 → { task } → starts a coordinator turn (SSE for progress)
//   GET    /:id/runs                → run history
//   GET    /:id/runs/:runId         → run detail
//   GET    /:id/runs/:runId/stream  → SSE: step_start | step_done | done | failed
//
// A run is one coordinator turn: the coordinator breaks the task into steps
// and assigns each step to the best-fit member via the `delegate` tool's
// `bot` parameter. Members get scoped subtasks; the coordinator synthesizes
// the final answer. Delegation flows through normal governance.

import express, { type Request, type Response, type Router } from 'express';
import { join } from 'node:path';
import {
  TeamStore,
  buildCoordinatorPrompt,
  type AgentRuntime,
  type BotConfig,
  type StreamEvent,
  type Team,
  type TeamStep,
} from '@mvp/agent-runtime';

export interface TeamRouteDeps {
  dataDir: string;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

type TeamEvent =
  | { kind: 'step_start'; index: number; step: TeamStep }
  | { kind: 'step_done'; index: number; step: TeamStep }
  | { kind: 'done'; result: string }
  | { kind: 'failed'; error: string };

function summarizeResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return text.slice(0, 400);
}

export function registerTeamRoutes(router: Router, deps: TeamRouteDeps): TeamStore {
  const store = new TeamStore(join(deps.dataDir));
  // runId → subscriber set for live SSE progress
  const subscribers = new Map<string, Set<(evt: TeamEvent) => void>>();

  const publish = (runId: string, evt: TeamEvent): void => {
    const set = subscribers.get(runId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(evt);
      } catch {
        // subscriber gone; SSE close handler removes it
      }
    }
  };

  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown; coordinatorBotId?: unknown; memberBotIds?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    const coordinatorBotId = typeof body.coordinatorBotId === 'string' ? body.coordinatorBotId : '';
    const memberBotIds = Array.isArray(body.memberBotIds)
      ? (body.memberBotIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const bots = new Map(deps.getBots().map((b) => [b.id, b]));
    if (!coordinatorBotId || !bots.has(coordinatorBotId)) {
      res.status(400).json(errorBody('coordinatorBotId must be a known bot id'));
      return;
    }
    const members = [...new Set(memberBotIds)];
    if (members.length === 0) {
      res.status(400).json(errorBody('memberBotIds must list at least one bot'));
      return;
    }
    for (const m of members) {
      if (!bots.has(m)) {
        res.status(400).json(errorBody(`unknown member bot "${m}"`));
        return;
      }
      if (m === coordinatorBotId) {
        res.status(400).json(errorBody('coordinator cannot also be a member'));
        return;
      }
    }
    const team = store.createTeam(name, coordinatorBotId, members);
    res.json({ ok: true, team });
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, teams: store.listTeams() });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    if (!store.deleteTeam(id)) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    res.json({ ok: true, deleted: id });
  });

  /** Fire-and-forget coordinator turn for a team run. */
  const executeRun = (team: Team, runId: string): void => {
    const bots = new Map(deps.getBots().map((b) => [b.id, b]));
    const coordinator = bots.get(team.coordinatorBotId);
    if (!coordinator) {
      store.updateRun(runId, { status: 'failed', error: `coordinator bot "${team.coordinatorBotId}" no longer exists` });
      publish(runId, { kind: 'failed', error: 'coordinator bot missing' });
      return;
    }
    const run = store.getRun(runId);
    if (!run) return;
    const members = team.memberBotIds
      .map((id) => bots.get(id))
      .filter((b): b is BotConfig => Boolean(b));
    const prompt = buildCoordinatorPrompt({
      teamName: team.name,
      coordinatorName: coordinator.name,
      members: members.map((m) => ({ id: m.id, name: m.name, description: m.description })),
      task: run.task,
    });

    let resultText = '';
    let steps: TeamStep[] = [];
    const stepByCallId = new Map<string, number>();

    void (async () => {
      try {
        await deps.agentRuntime.runTurn({
          bot: coordinator,
          message: prompt,
          sessionId: `team_${team.id}_${runId}`,
          taskType: 'chat',
          onEvent: async (e: StreamEvent) => {
            if (e.type === 'token') {
              resultText += e.content;
            } else if (e.type === 'tool_call' && e.call.name === 'delegate') {
              const botId = typeof e.call.args?.bot === 'string' && e.call.args.bot ? e.call.args.bot : coordinator.id;
              const taskArg = typeof e.call.args?.task === 'string' ? e.call.args.task : '';
              const member = bots.get(botId);
              const step: TeamStep = {
                memberBotId: botId,
                memberName: member?.name ?? botId,
                task: taskArg.slice(0, 500),
                done: false,
              };
              steps = [...steps, step];
              stepByCallId.set(e.call.id, steps.length - 1);
              store.updateRun(runId, { steps });
              publish(runId, { kind: 'step_start', index: steps.length - 1, step });
            } else if (e.type === 'tool_result' && e.call.name === 'delegate') {
              const idx = stepByCallId.get(e.call.id);
              if (idx !== undefined && steps[idx]) {
                steps = steps.map((s, i) =>
                  i === idx ? { ...s, done: true, summary: summarizeResult(e.result) } : s,
                );
                store.updateRun(runId, { steps });
                publish(runId, { kind: 'step_done', index: idx, step: steps[idx] });
              }
            } else if (e.type === 'error') {
              store.updateRun(runId, { status: 'failed', steps, error: e.message });
              publish(runId, { kind: 'failed', error: e.message });
            } else if (e.type === 'interrupted') {
              store.updateRun(runId, { status: 'failed', steps, error: `interrupted: ${e.reason}` });
              publish(runId, { kind: 'failed', error: `interrupted: ${e.reason}` });
            }
          },
        });
        const final = store.getRun(runId);
        if (final && final.status === 'running') {
          store.updateRun(runId, { status: 'done', steps, result: resultText.trim() });
          publish(runId, { kind: 'done', result: resultText.trim() });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.updateRun(runId, { status: 'failed', steps, error: message });
        publish(runId, { kind: 'failed', error: message });
      } finally {
        subscribers.delete(runId);
      }
    })();
  };

  router.post('/:id/run', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    const team = store.getTeam(id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    const body = (req.body ?? {}) as { task?: unknown };
    const task = typeof body.task === 'string' ? body.task.trim().slice(0, 8000) : '';
    if (!task) {
      res.status(400).json(errorBody('"task" is required'));
      return;
    }
    const run = store.startRun(id, task);
    executeRun(team, run.id);
    res.json({ ok: true, run });
  });

  router.get('/:id/runs', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid team id'));
      return;
    }
    if (!store.getTeam(id)) {
      res.status(404).json(errorBody(`Unknown team "${id}"`));
      return;
    }
    res.json({ ok: true, runs: store.listRuns(id) });
  });

  router.get('/:id/runs/:runId', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== req.params.id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.json({ ok: true, run });
  });

  router.get('/:id/runs/:runId/stream', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== req.params.id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // Replay current state so late joiners see progress so far.
    const current = store.getRun(run.id);
    if (current) {
      current.steps.forEach((step, index) => {
        res.write(`data: ${JSON.stringify({ kind: step.done ? 'step_done' : 'step_start', index, step })}\n\n`);
      });
      if (current.status === 'done') {
        res.write(`data: ${JSON.stringify({ kind: 'done', result: current.result ?? '' })}\n\n`);
        res.end();
        return;
      }
      if (current.status === 'failed') {
        res.write(`data: ${JSON.stringify({ kind: 'failed', error: current.error ?? 'failed' })}\n\n`);
        res.end();
        return;
      }
    }
    let set = subscribers.get(run.id);
    if (!set) {
      set = new Set();
      subscribers.set(run.id, set);
    }
    const send = (evt: TeamEvent): void => {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
        if (evt.kind === 'done' || evt.kind === 'failed') {
          res.end();
        }
      } catch {
        // client gone; close handler removes the subscriber
      }
    };
    set.add(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      const s = subscribers.get(run.id);
      if (s) s.delete(send);
    });
  });

  return store;
}
