// SPDX-License-Identifier: Apache-2.0
// Multi-tenant org/team routes (Phase 4, Workstream C).
//
// Mount at /api by the integrator, e.g.:
//   import { registerTenancyRoutes } from './tenancy.js';
//   const apiRouter = express.Router();
//   registerTenancyRoutes(apiRouter, deps);
//   app.use('/api', apiRouter);
//
// Routes (router mounted at /api):
//   POST   /orgs                        → { name } → Org (creator becomes owner)
//   GET    /orgs                        → [{ org, role }] for the caller
//   GET    /orgs/:id                    → Org + members (viewer: PII-masked)
//   GET    /orgs/:id/members            → Membership[] (viewer: PII-masked)
//   PUT    /orgs/:id/members/:userId    → { role } → Membership (owner/admin)
//   DELETE /orgs/:id/members/:userId    → { ok: true } (owner/admin)
//   POST   /orgs/:id/invites            → { email, role } → Invite (admin+)
//   GET    /orgs/:id/invites            → Invite[] (admin+)
//   DELETE /orgs/:id/invites/:email     → { ok: true } (admin+)
//   POST   /orgs/invites/accept         → { token } → Membership
//   GET    /orgs/:id/scope              → tenantScope() filter descriptor
//
// Identity: the caller is `x-user-id` (fallback 'default-user'). Deny-by-
// default: every org-scoped route 403s unless the caller is a member meeting
// the required role. Invite tokens are never logged.

import express from 'express';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { TenantStore, canAct, isRole, maskForViewer, tenantScope } from '@mvp/tenancy';
import type { Role } from '@mvp/tenancy';
import type { RouteDeps } from './routes.js';

type TenancyDeps = Pick<RouteDeps, 'config' | 'governance'>;

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function callerOf(req: Request): string {
  const header = req.header('x-user-id');
  return typeof header === 'string' && header.length > 0 ? header : 'default-user';
}

export function registerTenancyRoutes(router: express.Router, deps: TenancyDeps): void {
  const store = new TenantStore(join(deps.config.dataDir, 'tenancy.db'));
  const { governance } = deps;
  const sub = express.Router();

  // Resolve the caller's role in the org from :id. Fails closed: unknown
  // org or non-member → 403 (we don't distinguish, to avoid org enumeration).
  function roleOf(req: Request): { orgId: string; userId: string; role: Role } | undefined {
    const orgId = req.params.id;
    const userId = callerOf(req);
    const membership = store.getMembership(orgId, userId);
    if (!membership) return undefined;
    return { orgId, userId, role: membership.role };
  }

  function deny(res: Response, required: Role): void {
    res.status(403).json(errorBody(`requires the "${required}" role or higher in this org`));
  }

  // POST /orgs — create an org; the caller becomes its owner.
  sub.post('/', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown };
      const org = store.createOrg(body.name as string, callerOf(req));
      governance.audit('tenancy.org_created', {
        actor: callerOf(req),
        toolName: 'tenancy',
        detail: { orgId: org.id, name: org.name },
      });
      res.status(201).json({ org, role: 'owner' as Role });
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to create org', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /orgs — orgs the caller belongs to.
  sub.get('/', (req: Request, res: Response) => {
    try {
      res.json(store.listOrgsForUser(callerOf(req)));
    } catch (err) {
      res
        .status(500)
        .json(errorBody('Failed to list orgs', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /orgs/invites/accept — accept an invite by token (before :id routes).
  sub.post('/invites/accept', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { token?: unknown };
      const membership = store.acceptInvite(String(body.token ?? ''), callerOf(req));
      governance.audit('tenancy.invite_accepted', {
        actor: callerOf(req),
        toolName: 'tenancy',
        detail: { orgId: membership.orgId, role: membership.role },
      });
      res.status(201).json({ orgId: membership.orgId, role: membership.role });
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to accept invite', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /orgs/:id — org detail + members. Viewers get PII-masked members.
  sub.get('/:id', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx) {
      deny(res, 'viewer');
      return;
    }
    const org = store.getOrg(ctx.orgId);
    if (!org) {
      res.status(404).json(errorBody(`unknown org: ${ctx.orgId}`));
      return;
    }
    const members = store.listMembers(ctx.orgId);
    res.json({ org, members: ctx.role === 'viewer' ? maskForViewer(members) : members });
  });

  // GET /orgs/:id/members — tenant-scoped member listing.
  sub.get('/:id/members', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx) {
      deny(res, 'viewer');
      return;
    }
    const members = store.listMembers(ctx.orgId);
    res.json(ctx.role === 'viewer' ? maskForViewer(members) : members);
  });

  // PUT /orgs/:id/members/:userId — role assignment (owner/admin only).
  sub.put('/:id/members/:userId', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx || !canAct(ctx.role, 'admin')) {
      deny(res, 'admin');
      return;
    }
    try {
      const body = (req.body ?? {}) as { role?: unknown };
      if (!isRole(body.role)) {
        res.status(400).json(errorBody('role must be one of: owner, admin, member, viewer'));
        return;
      }
      const membership = store.setRole(ctx.orgId, req.params.userId, body.role);
      governance.audit('tenancy.role_changed', {
        actor: ctx.userId,
        toolName: 'tenancy',
        detail: { orgId: ctx.orgId, targetUser: req.params.userId, role: body.role },
      });
      res.json(membership);
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to set role', err instanceof Error ? err.message : String(err)));
    }
  });

  // DELETE /orgs/:id/members/:userId — remove a member (owner/admin only).
  sub.delete('/:id/members/:userId', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx || !canAct(ctx.role, 'admin')) {
      deny(res, 'admin');
      return;
    }
    try {
      store.removeMember(ctx.orgId, req.params.userId);
      governance.audit('tenancy.member_removed', {
        actor: ctx.userId,
        toolName: 'tenancy',
        detail: { orgId: ctx.orgId, targetUser: req.params.userId },
      });
      res.json({ ok: true });
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to remove member', err instanceof Error ? err.message : String(err)));
    }
  });

  // POST /orgs/:id/invites — invite a user (admin+). The token is returned
  // once here; it is never logged.
  sub.post('/:id/invites', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx || !canAct(ctx.role, 'admin')) {
      deny(res, 'admin');
      return;
    }
    try {
      const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
      if (!isRole(body.role)) {
        res.status(400).json(errorBody('role must be one of: owner, admin, member, viewer'));
        return;
      }
      // Nobody can invite above their own rank (deny-by-default privilege cap).
      if (!canAct(ctx.role, body.role)) {
        deny(res, body.role);
        return;
      }
      const invite = store.createInvite(ctx.orgId, body.email as string, body.role);
      governance.audit('tenancy.invite_created', {
        actor: ctx.userId,
        toolName: 'tenancy',
        detail: { orgId: ctx.orgId, email: invite.email, role: invite.role },
      });
      res.status(201).json(invite);
    } catch (err) {
      res
        .status(400)
        .json(errorBody('Failed to create invite', err instanceof Error ? err.message : String(err)));
    }
  });

  // GET /orgs/:id/invites — pending invites (admin+).
  sub.get('/:id/invites', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx || !canAct(ctx.role, 'admin')) {
      deny(res, 'admin');
      return;
    }
    res.json(store.listInvites(ctx.orgId));
  });

  // DELETE /orgs/:id/invites/:email — revoke (admin+).
  sub.delete('/:id/invites/:email', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx || !canAct(ctx.role, 'admin')) {
      deny(res, 'admin');
      return;
    }
    const removed = store.revokeInvite(ctx.orgId, req.params.email);
    if (!removed) {
      res.status(404).json(errorBody(`no pending invite for "${req.params.email}"`));
      return;
    }
    governance.audit('tenancy.invite_revoked', {
      actor: ctx.userId,
      toolName: 'tenancy',
      detail: { orgId: ctx.orgId, email: req.params.email },
    });
    res.json({ ok: true });
  });

  // GET /orgs/:id/scope — the tenantScope() filter descriptor for this org.
  // Developer-facing documentation endpoint: other features (vault metadata,
  // task lists, …) reuse tenantScope(orgId) so every query carries the
  // parameterized "org_id" = ? filter and cross-tenant rows never leak.
  sub.get('/:id/scope', (req: Request, res: Response) => {
    const ctx = roleOf(req);
    if (!ctx) {
      deny(res, 'viewer');
      return;
    }
    res.json({ orgId: ctx.orgId, filter: tenantScope(ctx.orgId) });
  });

  router.use('/orgs', sub);
}
