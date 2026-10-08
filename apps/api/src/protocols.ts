// SPDX-License-Identifier: Apache-2.0
// Interop protocol HTTP routes (@mvp/protocols over express).
//
// Mount at boot, e.g.:
//   import { registerProtocolRoutes } from './protocols.js';
//   const protocolsRouter = express.Router();
//   registerProtocolRoutes(protocolsRouter, { agentCardUrl: 'https://host/api/protocols/a2a' });
//   app.use('/api/protocols', protocolsRouter);
//   // Spec-correct card location (A2A discovery):
//   app.get('/.well-known/agent-card.json', (_req, res) => res.json(defaultAgentCard('https://host/api/protocols/a2a')));
//
// Routes (router mounted at /api/protocols):
//   GET  /agent-card  → AgentCard JSON (also serve at /.well-known/agent-card.json — see above)
//   POST /a2a         → JSON-RPC 2.0: message/send, tasks/get, tasks/cancel
//   GET  /agui/stream → SSE stream of AG-UI events for the web client

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  A2AServer,
  AGUIEmitter,
  JSON_RPC_ERRORS,
  defaultAgentCard,
  serializeSseEvent,
} from '@mvp/protocols';

export interface ProtocolRouteDeps {
  /**
   * Base URL advertised on the agent card. Defaults to a relative path so
   * the card is still valid behind any host.
   */
  agentCardUrl?: string;
  /** A2A server handling JSON-RPC. Defaults to a fresh in-memory server. */
  a2aServer?: A2AServer;
  /** Shared AG-UI emitter fanned out to SSE subscribers. Defaults to a fresh one. */
  aguiEmitter?: AGUIEmitter;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function registerProtocolRoutes(router: Router, deps: ProtocolRouteDeps = {}): void {
  const cardUrl = deps.agentCardUrl ?? '/api/protocols/a2a';
  const card = () => defaultAgentCard(cardUrl);
  const a2a = deps.a2aServer ?? new A2AServer({ card: card() });
  const emitter = deps.aguiEmitter ?? new AGUIEmitter();

  router.get('/agent-card', (_req: Request, res: Response) => {
    res.json(card());
  });

  router.post('/a2a', async (req: Request, res: Response) => {
    // express.json() already parsed the body; a missing/invalid body is a
    // JSON-RPC parse error per spec.
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.parseError, message: 'Parse error: expected a JSON-RPC 2.0 object body' },
      });
      return;
    }
    try {
      const response = await a2a.handleJsonRpc(req.body);
      res.json(response);
    } catch (err) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: (req.body as { id?: string | number }).id ?? null,
        error: { code: JSON_RPC_ERRORS.internalError, message: errMessage(err, 'A2A handler failed') },
      });
    }
  });

  router.get('/agui/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Let the client know the stream is alive.
    res.write(': connected\n\n');

    const unsubscribe = emitter.subscribe((event) => {
      try {
        res.write(serializeSseEvent(event));
      } catch {
        // Client gone; the 'close' handler below cleans up.
      }
    });

    // Heartbeat comment every 15s keeps proxies from closing idle streams.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore; close handler tears down
      }
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });
}
