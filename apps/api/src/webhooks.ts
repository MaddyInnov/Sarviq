// SPDX-License-Identifier: Apache-2.0
// Inbound webhook entry points for workflow triggers.
//
// POST /webhooks/:triggerId
//   - 404 when the trigger id is unknown, disabled, or not a webhook trigger
//   - 401 when the `x-webhook-secret` header does not match the stored secret
//     (compared with crypto.timingSafeEqual over SHA-256 digests)
//   - otherwise starts a workflow run and returns { runId }
//
// Mount at boot, e.g. `app.use('/webhooks', createWebhookRouter({ runner, triggerStore }))`.
// The TriggerStore/WorkflowRunner are constructed in the API boot sequence.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { WorkflowRunner } from '@mvp/workflows';
// Deep import: TriggerStore lives in @mvp/workflows' triggers module
// (not re-exported from the package index by design of this workstream).
import { TriggerStore } from '@mvp/workflows/dist/triggers.js';

export { TriggerStore };

export interface WebhookRouterOptions {
  runner: WorkflowRunner;
  triggerStore: TriggerStore;
}

function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function createWebhookRouter(opts: WebhookRouterOptions): Router {
  const router = Router();

  router.post('/:triggerId', async (req: Request, res: Response) => {
    const triggerId = req.params.triggerId;
    const trigger = opts.triggerStore.get(triggerId);
    if (!trigger || !trigger.enabled || trigger.kind !== 'webhook' || !trigger.secret) {
      res.status(404).json({ error: 'unknown webhook trigger' });
      return;
    }
    const provided = req.header('x-webhook-secret');
    if (!secretsMatch(provided, trigger.secret)) {
      res.status(401).json({ error: 'invalid webhook secret' });
      return;
    }
    try {
      // Optional idempotency for senders that retry deliveries.
      const idempotencyKey = req.header('x-idempotency-key') || undefined;
      const run = await opts.runner.startRun(
        trigger.workflowId,
        {
          trigger: 'webhook',
          triggerId: trigger.id,
          receivedAt: new Date().toISOString(),
          body: req.body,
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      res.status(200).json({ runId: run.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to start run' });
    }
    return;
  });

  return router;
}
