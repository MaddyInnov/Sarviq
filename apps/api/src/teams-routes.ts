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
//   GET    /:id/delegation-policy   → { delegationPolicy, delegationPolicyOverrides }
//   PATCH  /:id/delegation-policy   → { delegationPolicy?, delegationPolicyOverrides? }
//
// Peer-delegation approval (workstream C): when the coordinator's `delegate`
// tool targets another bot, the run's delegate gate consults the team's
// delegation policy ('approve-once-per-team' | 'always-ask' | 'always-allow',
// per-bot overrides supported). Unless the policy says 'always-allow' (or a
// grant already covers the team), the gate mints an approval through the
// approval broker — the user decides in the approvals inbox/cards — and a
// denial aborts the subtask with a clear message.
//
// A run is one coordinator turn: the coordinator breaks the task into steps
// and assigns each step to the best-fit member via the `delegate` tool's
// `bot` parameter. Members get scoped subtasks; the coordinator synthesizes
// the final answer. Delegation flows through normal governance.

import express, { type Request, type Response, type Router } from 'express';
import { join } from 'node:path';
import {
  DEFAULT_DELEGATION_POLICY,
  DELEGATION_POLICIES,
  TeamDirectoryStore,
  TeamStore,
  buildCoordinatorPrompt,
  enrichActor,
  isDelegationPolicy,
  resolveDelegationPolicy,
  withEnrichedRunActors,
  type AgentRuntime,
  type BotConfig,
  type DelegateGate,
  type DelegationPolicy,
  type StreamEvent,
  type Team,
  type TeamRun,
  type TeamStep,
} from '@mvp/agent-runtime';

export interface TeamRouteDeps {
  dataDir: string;
  agentRuntime: AgentRuntime;
  getBots: () => BotConfig[];
  /**
   * Approval broker for team peer-delegation (workstream C). When set,
   * bot→bot delegation in coordinator runs is gated on user approval per
   * the team's delegation policy; the broker mints the approval card and
   * the user decides in the approvals inbox. Unset → the peer-approval gate
   * allows delegations (pre-workstream behaviour) with a console warning.
   *
   * HOST WIRING: pass `deps.governanceAdapter` (GovernanceAdapter
   * implements this interface structurally via
   * requestPeerDelegationApproval + awaitDecision).
   */
  delegationBroker?: DelegationApprovalBroker;
}

/**
 * Minimal approval-broker surface the delegation gate needs: mint a
 * peer-delegation approval card, then wait for the human decision.
 */
export interface DelegationApprovalBroker {
  requestPeerDelegationApproval(args: {
    sessionId: string;
    botId: string;
    fromBotId: string;
    toBotId: string;
    task: string;
    policy: DelegationPolicy;
  }): Promise<string>;
  awaitDecision(approvalId: string, opts?: { timeoutMs?: number }): Promise<'approved' | 'denied'>;
}

/**
 * Build the delegate gate for one team's coordinator runs. The gate runs
 * before governance on every `delegate` tool call:
 * - self-delegation (no `bot` arg, or `bot` === caller) is a plain subagent
 *   spawn, not peer delegation → allow.
 * - 'always-allow' → allow.
 * - 'approve-once-per-team' with an existing grant → allow.
 * - otherwise mint an approval through the broker and await the user's
 *   decision; 'approved' → allow (recording the grant for
 *   approve-once-per-team), anything else → deny with a clear message that
 *   aborts the subtask.
 */
export function createDelegationGate(
  teamId: string,
  opts: { store: TeamStore; broker?: DelegationApprovalBroker },
): DelegateGate {
  return async (call, ctx) => {
    const team = opts.store.getTeam(teamId);
    const targetBotId =
      typeof call.args?.bot === 'string' && call.args.bot ? call.args.bot : ctx.botId;
    if (!team || targetBotId === ctx.botId) return { decision: 'allow' };
    const policy = resolveDelegationPolicy(team, targetBotId);
    if (policy === 'always-allow') return { decision: 'allow' };
    if (policy === 'approve-once-per-team' && opts.store.hasDelegationGrant(teamId)) {
      return { decision: 'allow' };
    }
    if (!opts.broker) {
      console.warn(
        `[teams] delegation approval broker not wired; allowing peer delegation in team "${teamId}" without approval`,
      );
      return { decision: 'allow' };
    }
    const taskText = typeof call.args?.task === 'string' ? call.args.task : '';
    let approvalId: string;
    try {
      approvalId = await opts.broker.requestPeerDelegationApproval({
        sessionId: ctx.sessionId,
        botId: ctx.botId,
        fromBotId: ctx.botId,
        toBotId: targetBotId,
        task: taskText,
        policy,
      });
    } catch (err) {
      return {
        decision: 'deny',
        reason: `could not request delegation approval: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let verdict: 'approved' | 'denied';
    try {
      verdict = await opts.broker.awaitDecision(approvalId);
    } catch (err) {
      return {
        decision: 'deny',
        reason: `delegation approval failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (verdict !== 'approved') {
      return {
        decision: 'deny',
        reason:
          `the delegation was not approved (team "${team.name}", policy "${policy}"): ` +
          `subtask for member bot "${targetBotId}" was not started. Reassign the step or proceed without it.`,
      };
    }
    if (policy === 'approve-once-per-team') opts.store.recordDelegationGrant(teamId);
    return { decision: 'allow' };
  };
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
  const dirStore = new TeamDirectoryStore(join(deps.dataDir));
  // runId → subscriber set for live SSE progress
  const subscribers = new Map<string, Set<(evt: TeamEvent) => void>>();

  // Every step returned over the API carries an enriched `actor` field:
  // matched against the team directory ({role, team, relationship}), and
  // passed through unchanged when unmatched.
  const enrichRun = (run: TeamRun) => withEnrichedRunActors(run, dirStore);

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
    const body = (req.body ?? {}) as {
      name?: unknown;
      coordinatorBotId?: unknown;
      memberBotIds?: unknown;
      delegationPolicy?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name : '';
    const coordinatorBotId = typeof body.coordinatorBotId === 'string' ? body.coordinatorBotId : '';
    const memberBotIds = Array.isArray(body.memberBotIds)
      ? (body.memberBotIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const delegationPolicy =
      body.delegationPolicy === undefined ? undefined : body.delegationPolicy;
    if (delegationPolicy !== undefined && !isDelegationPolicy(delegationPolicy)) {
      res
        .status(400)
        .json(errorBody(`delegationPolicy must be one of: ${DELEGATION_POLICIES.join(', ')}`));
      return;
    }
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
    if (delegationPolicy) store.setDelegationPolicy(team.id, delegationPolicy);
    res.json({ ok: true, team: store.getTeam(team.id) ?? team });
  });

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, teams: store.listTeams() });
  });

  // -- Delegation policy (workstream C) -----------------------------------
  //   GET    /:id/delegation-policy   → { ok, teamId, delegationPolicy,
  //                                       delegationPolicyOverrides }
  //   PATCH  /:id/delegation-policy   → { delegationPolicy?,
  //                                       delegationPolicyOverrides? }
  //                                     → { ok, team }
  //
  // Controls how bot→bot delegation in coordinator runs is gated on user
  // approval: 'approve-once-per-team' (default), 'always-ask',
  // 'always-allow'. Overrides map a member bot id to its own policy.
  // Changing the policy revokes any existing approve-once grant.

  router.get('/:id/delegation-policy', (req: Request, res: Response) => {
    const team = store.getTeam(req.params.id);
    if (!team) {
      res.status(404).json(errorBody(`Unknown team "${req.params.id}"`));
      return;
    }
    res.json({
      ok: true,
      teamId: team.id,
      delegationPolicy: team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY,
      delegationPolicyOverrides: team.delegationPolicyOverrides ?? {},
    });
  });

  router.patch('/:id/delegation-policy', (req: Request, res: Response) => {
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
    const body = (req.body ?? {}) as {
      delegationPolicy?: unknown;
      delegationPolicyOverrides?: unknown;
    };
    const policy =
      body.delegationPolicy === undefined
        ? (team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY)
        : body.delegationPolicy;
    if (!isDelegationPolicy(policy)) {
      res
        .status(400)
        .json(errorBody(`delegationPolicy must be one of: ${DELEGATION_POLICIES.join(', ')}`));
      return;
    }
    let overrides: Record<string, DelegationPolicy> | undefined;
    if (body.delegationPolicyOverrides !== undefined) {
      const raw = body.delegationPolicyOverrides;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        res.status(400).json(errorBody('delegationPolicyOverrides must be an object of botId → policy'));
        return;
      }
      overrides = {};
      for (const [botId, p] of Object.entries(raw as Record<string, unknown>)) {
        if (!team.memberBotIds.includes(botId)) {
          res.status(400).json(errorBody(`override bot "${botId}" is not a member of this team`));
          return;
        }
        if (!isDelegationPolicy(p)) {
          res
            .status(400)
            .json(errorBody(`override for "${botId}" must be one of: ${DELEGATION_POLICIES.join(', ')}`));
          return;
        }
        overrides[botId] = p;
      }
    }
    const updated = store.setDelegationPolicy(id, policy, overrides ?? team.delegationPolicyOverrides);
    if (body.delegationPolicy !== undefined) {
      // A policy change invalidates any approve-once grant.
      store.revokeDelegationGrant(id);
    }
    res.json({ ok: true, team: updated });
  });

  // -- Team directory (actor enrichment) ---------------------------------
  // Registered before the `/:id` routes so `/directory` is never mistaken
  // for a team id.
  //
  //   GET    /directory              → { ok, members }
  //   POST   /directory              → { name, handle?, email?, role?,
  //                                     team?, timezone?, notes?,
  //                                     relationship? } → { ok, member }
  //   PATCH  /directory/:memberId    → { ok, member }
  //   DELETE /directory/:memberId    → { ok, deleted }

  router.get('/directory', (_req: Request, res: Response) => {
    res.json({ ok: true, members: dirStore.listMembers() });
  });

  router.post('/directory', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const member = dirStore.addMember({
        name: typeof body.name === 'string' ? body.name : '',
        handle: typeof body.handle === 'string' ? body.handle : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        role: typeof body.role === 'string' ? body.role : undefined,
        team: typeof body.team === 'string' ? body.team : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        relationship: typeof body.relationship === 'string' ? body.relationship : undefined,
      });
      res.status(201).json({ ok: true, member });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to add directory member'));
    }
  });

  router.patch('/directory/:memberId', (req: Request, res: Response) => {
    const memberId = req.params.memberId;
    if (!validId(memberId)) {
      res.status(400).json(errorBody('Invalid member id'));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const key of ['name', 'handle', 'email', 'role', 'team', 'timezone', 'notes', 'relationship'] as const) {
      if (typeof body[key] === 'string') patch[key] = body[key] as string;
    }
    try {
      const member = dirStore.updateMember(memberId, patch);
      if (!member) {
        res.status(404).json(errorBody(`Unknown directory member "${memberId}"`));
        return;
      }
      res.json({ ok: true, member });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'Failed to update directory member'));
    }
  });

  router.delete('/directory/:memberId', (req: Request, res: Response) => {
    const memberId = req.params.memberId;
    if (!validId(memberId)) {
      res.status(400).json(errorBody('Invalid member id'));
      return;
    }
    if (!dirStore.deleteMember(memberId)) {
      res.status(404).json(errorBody(`Unknown directory member "${memberId}"`));
      return;
    }
    res.json({ ok: true, deleted: memberId });
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
          // Peer-delegation approval (workstream C): bot→bot delegation is
          // gated on user approval per the team's delegation policy.
          delegateGate: createDelegationGate(team.id, { store, broker: deps.delegationBroker }),
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
    res.json({ ok: true, run: enrichRun(run) });
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
    res.json({ ok: true, runs: store.listRuns(id).map(enrichRun) });
  });

  router.get('/:id/runs/:runId', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run || run.teamId !== req.params.id) {
      res.status(404).json(errorBody('Unknown run'));
      return;
    }
    res.json({ ok: true, run: enrichRun(run) });
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
      enrichRun(current).steps.forEach((step, index) => {
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
        // Enrich step actors against the team directory for live events too.
        const out =
          evt.kind === 'step_start' || evt.kind === 'step_done'
            ? { ...evt, step: { ...evt.step, actor: enrichActor(evt.step.memberName, dirStore) } }
            : evt;
        res.write(`data: ${JSON.stringify(out)}\n\n`);
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
