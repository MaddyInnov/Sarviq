// SPDX-License-Identifier: Apache-2.0
// Muse-parity module REST endpoints (Phase 4, Workstream E).
//
// Mount at boot, e.g.:
//   import { registerMuseModuleRoutes } from './muse-modules.js';
//   const modulesRouter = express.Router();
//   registerMuseModuleRoutes(modulesRouter, deps); // deps: RouteDeps
//   app.use('/api/modules', modulesRouter);
//
// (The integrator wires this file — like notes.ts — so index.ts/routes.ts
// are intentionally untouched here.)
//
// Sub-routers (paths relative to the mount point):
//   /overview
//   /feed        GET /brief · PUT /brief · GET /posts · POST /posts/generate
//                POST /posts/:id/dismiss · POST /schedule
//   /reminders   GET / · POST / · GET /due · GET /:id · POST /:id/cancel
//                POST /:id/done · POST /:id/fire
//   /goals       GET / · POST / · GET /:id · POST /:id/progress
//                POST /:id/complete · GET /:id/history
//   /artifacts   GET / · POST / · GET /:id · PUT /:id · GET /:id/versions
//   /media       POST /generate
//   /calls       GET / · POST / · GET /:id
//   /threads     GET / · POST / · GET /:id · PATCH /:id · DELETE /:id
//                POST /:id/messages
//   /research    POST / · GET / · GET /:id
//   /browser     POST /request · GET /approvals · GET /approvals/:id
//                POST /approvals/:id/decision · POST /approvals/:id/execute
//   /ideas       GET / · POST / · POST /:id/run · POST /:id/dismiss
//                POST /:id/complete
//   /shopping    GET /products · GET /products/:id · POST /carts
//                GET /carts/:id · POST /carts/:id/items
//                POST /carts/:id/checkout · GET /orders/:id
//                POST /orders/:id/approve · POST /orders/:id/cancel
//   /places      GET /search · GET /:id · GET /:id/map
//   /social      GET /watchlist · POST /watchlist · DELETE /watchlist/:id
//                GET /digest
//   /meetings    GET / · POST /upload { fileName, audioBase64, title? }
//   /slides      GET / · POST / · GET /:id · PUT /:id · DELETE /:id
//                POST /:id/export { format: 'html' | 'markdown' }
//   /kb          POST /documents (octet-stream, ?fileName=&title=&mimeType=&corpusId=)
//                GET /documents · DELETE /documents/:id
//                POST /query { query, topK?, corpusIds? } · POST /answer
//                GET /corpora · POST /corpora · DELETE /corpora/:id
//
// Trust notes:
// - Browser actions are approval-gated (request → decide → execute); the
//   execute endpoint refuses unapproved actions. Extracted page text is
//   untrusted external data.
// - Shopping checkout is two-phase: checkout → pending_approval order, then
//   approve with the returned mock approval code. No silent purchases.
// - No secrets are accepted or stored by these endpoints; provider
//   credentials remain environment variables (see workstream-e.md).

import { join } from 'node:path';
import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { TriggerStore } from '@mvp/workflows';
import {
  ModuleDb,
  statusForError,
  messageForError,
  FeedStore,
  MockFeedGenerator,
  generateFeedPosts,
  scheduleFeedGeneration,
  ReminderStore,
  scheduleReminder,
  fireReminder,
  GoalStore,
  ArtifactStore,
  MockMediaProvider,
  MockVoiceCallProvider,
  CallLog,
  ThreadStore,
  ResearchStore,
  MockSearchTool,
  runDeepResearch,
  BrowserAutomation,
  selectBrowserDriver,
  IdeaStore,
  ShoppingStore,
  searchProducts,
  getProduct,
  MockPlaceSearch,
  mapWidgetPayload,
  mapWidgetForPlaces,
  MockSocialSearch,
  WatchlistStore,
  buildDigest,
  renderDigestMarkdown,
  MeetingStore,
  transcribeMeetingAudio,
  meetingSummaryPrompt,
  parseMeetingSummary,
  renderMeetingNotesMarkdown,
  validateAudioFile,
  SlideDeckStore,
  exportDeckMarkdown,
  exportDeckHtml,
  KnowledgeBaseStore,
  LocalEmbedder,
  extractText,
  formatCitedSources,
  appendSourcesSection,
} from '@mvp/muse-modules';
import type { RouteDeps } from './routes.js';
import { MockSTTProvider } from '@mvp/voice';
import { PageStore } from './pages.js';

function sendError(res: Response, err: unknown, fallback: string): void {
  res.status(statusForError(err)).json({ error: messageForError(err, fallback) });
}

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export function registerMuseModuleRoutes(router: Router, deps: RouteDeps): void {
  const dataDir = deps.config.dataDir;
  const mdb = new ModuleDb(join(dataDir, 'muse-modules.db'));

  const feed = new FeedStore(mdb);
  const reminders = new ReminderStore(mdb);
  const goals = new GoalStore(mdb);
  const artifacts = new ArtifactStore(mdb);
  const media = new MockMediaProvider();
  const calls = new CallLog(mdb);
  const callProvider = new MockVoiceCallProvider();
  const threads = new ThreadStore(mdb);
  const research = new ResearchStore(mdb);
  const searchTool = new MockSearchTool();
  // Real foreground browser only when BROWSER_REAL=1; otherwise the mock.
  // The request → approve → execute pipeline is unchanged — approval is
  // still required before anything runs, regardless of driver.
  const browser = new BrowserAutomation(mdb, selectBrowserDriver());
  const ideas = new IdeaStore(mdb);
  const shopping = new ShoppingStore(mdb);
  const places = new MockPlaceSearch();
  const socialSearch = new MockSocialSearch();
  const watchlist = new WatchlistStore(mdb);

  // ---- Overview -----------------------------------------------------------
  router.get('/overview', (_req: Request, res: Response) => {
    try {
      res.json({
        feed: { briefSet: feed.getBrief() !== null, posts: feed.listPosts().length },
        reminders: { scheduled: reminders.list('scheduled').length },
        goals: { active: goals.list('active').length, completed: goals.list('completed').length },
        artifacts: { count: artifacts.list().length },
        threads: { count: threads.list().length },
        ideas: { total: ideas.list().length, active: ideas.list('active').length },
        calls: { count: calls.list(1).length },
        research: { reports: research.list().length },
        social: { watchlist: watchlist.list().length },
        meetings: { count: new MeetingStore(mdb).list().length },
        slides: { count: new SlideDeckStore(mdb).list().length },
        kb: {
          documents: new KnowledgeBaseStore(mdb, new LocalEmbedder()).listDocuments().length,
          corpora: new KnowledgeBaseStore(mdb, new LocalEmbedder()).listCorpora().length,
        },
      });
    } catch (err) {
      sendError(res, err, 'failed to build modules overview');
    }
  });

  // ---- Feed ---------------------------------------------------------------
  const feedRouter = Router();
  feedRouter.get('/brief', (_req, res) => {
    try {
      res.json(feed.getBrief());
    } catch (err) {
      sendError(res, err, 'failed to read feed brief');
    }
  });
  feedRouter.put('/brief', (req, res) => {
    try {
      res.json(feed.setBrief(String(body(req).brief ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to set feed brief');
    }
  });
  feedRouter.get('/posts', (req, res) => {
    try {
      res.json(feed.listPosts(req.query.includeDismissed === '1'));
    } catch (err) {
      sendError(res, err, 'failed to list feed posts');
    }
  });
  feedRouter.post('/posts/generate', async (_req, res) => {
    try {
      res.status(201).json(await generateFeedPosts(feed, new MockFeedGenerator()));
    } catch (err) {
      sendError(res, err, 'failed to generate feed posts');
    }
  });
  feedRouter.post('/posts/:id/dismiss', (req, res) => {
    try {
      res.json(feed.dismissPost(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to dismiss feed post');
    }
  });
  feedRouter.post('/schedule', (req, res) => {
    try {
      const workflowId = String(body(req).workflowId ?? 'muse-feed-dispatch');
      const triggers = new TriggerStore(join(dataDir, 'triggers.db'));
      try {
        res.status(201).json(scheduleFeedGeneration(triggers, workflowId));
      } finally {
        triggers.close();
      }
    } catch (err) {
      sendError(res, err, 'failed to schedule feed generation');
    }
  });
  router.use('/feed', feedRouter);

  // ---- Reminders ----------------------------------------------------------
  const remindersRouter = Router();
  remindersRouter.get('/', (req, res) => {
    try {
      const status = req.query.status as 'scheduled' | 'fired' | 'done' | 'cancelled' | undefined;
      res.json(reminders.list(status));
    } catch (err) {
      sendError(res, err, 'failed to list reminders');
    }
  });
  remindersRouter.post('/', (req, res) => {
    try {
      const b = body(req);
      if (b.schedule) {
        const triggers = new TriggerStore(join(dataDir, 'triggers.db'));
        try {
          const { reminder, trigger } = scheduleReminder(reminders, triggers, {
            title: String(b.title ?? ''),
            when: Number(b.when),
            channel: (b.channel ?? 'push') as 'push' | 'email' | 'sms',
          });
          res.status(201).json({ reminder, trigger });
        } finally {
          triggers.close();
        }
      } else {
        res.status(201).json(
          reminders.create({
            title: String(b.title ?? ''),
            when: Number(b.when),
            channel: (b.channel ?? 'push') as 'push' | 'email' | 'sms',
          }),
        );
      }
    } catch (err) {
      sendError(res, err, 'failed to create reminder');
    }
  });
  remindersRouter.get('/due', (req, res) => {
    try {
      const now = req.query.now === undefined ? Date.now() : Number(req.query.now);
      res.json(reminders.listDue(now));
    } catch (err) {
      sendError(res, err, 'failed to list due reminders');
    }
  });
  remindersRouter.get('/:id', (req, res) => {
    try {
      res.json(reminders.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get reminder');
    }
  });
  remindersRouter.post('/:id/cancel', (req, res) => {
    try {
      res.json(reminders.cancel(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to cancel reminder');
    }
  });
  remindersRouter.post('/:id/done', (req, res) => {
    try {
      res.json(reminders.done(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to complete reminder');
    }
  });
  // Host scheduler hook: called when a `muse-reminder:<id>` cron trigger fires.
  remindersRouter.post('/:id/fire', (req, res) => {
    try {
      const fired = fireReminder(reminders, req.params.id);
      res.json({ fired: fired !== null, reminder: fired });
    } catch (err) {
      sendError(res, err, 'failed to fire reminder');
    }
  });
  router.use('/reminders', remindersRouter);

  // ---- Goals --------------------------------------------------------------
  const goalsRouter = Router();
  goalsRouter.get('/', (req, res) => {
    try {
      res.json(goals.list(req.query.status as 'active' | 'completed' | undefined));
    } catch (err) {
      sendError(res, err, 'failed to list goals');
    }
  });
  goalsRouter.post('/', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(goals.create({ title: String(b.title ?? ''), description: b.description as string | undefined }));
    } catch (err) {
      sendError(res, err, 'failed to create goal');
    }
  });
  goalsRouter.get('/:id', (req, res) => {
    try {
      res.json(goals.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get goal');
    }
  });
  goalsRouter.post('/:id/progress', (req, res) => {
    try {
      const b = body(req);
      res.json(goals.updateProgress(req.params.id, Number(b.pct), b.note as string | undefined));
    } catch (err) {
      sendError(res, err, 'failed to update goal progress');
    }
  });
  goalsRouter.post('/:id/complete', (req, res) => {
    try {
      res.json(goals.complete(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to complete goal');
    }
  });
  goalsRouter.get('/:id/history', (req, res) => {
    try {
      res.json(goals.history(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to read goal history');
    }
  });
  router.use('/goals', goalsRouter);

  // ---- Artifacts ----------------------------------------------------------
  const artifactsRouter = Router();
  artifactsRouter.get('/', (_req, res) => {
    try {
      res.json(artifacts.list());
    } catch (err) {
      sendError(res, err, 'failed to list artifacts');
    }
  });
  artifactsRouter.post('/', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(artifacts.create({ title: String(b.title ?? ''), content: String(b.content ?? '') }));
    } catch (err) {
      sendError(res, err, 'failed to create artifact');
    }
  });
  artifactsRouter.get('/:id', (req, res) => {
    try {
      res.json(artifacts.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get artifact');
    }
  });
  artifactsRouter.put('/:id', (req, res) => {
    try {
      res.json(artifacts.update(req.params.id, String(body(req).content ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to update artifact');
    }
  });
  artifactsRouter.get('/:id/versions', (req, res) => {
    try {
      res.json(artifacts.versions(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to list artifact versions');
    }
  });
  router.use('/artifacts', artifactsRouter);

  // ---- Media --------------------------------------------------------------
  const mediaRouter = Router();
  mediaRouter.post('/generate', async (req, res) => {
    try {
      const b = body(req);
      const asset = await media.generate(
        (b.kind ?? 'image') as 'image' | 'video' | 'audio',
        String(b.prompt ?? ''),
      );
      res.status(201).json(asset);
    } catch (err) {
      sendError(res, err, 'failed to generate media');
    }
  });
  router.use('/media', mediaRouter);

  // ---- Calls --------------------------------------------------------------
  const callsRouter = Router();
  callsRouter.get('/', (req, res) => {
    try {
      res.json(calls.list(Number(req.query.limit ?? 50)));
    } catch (err) {
      sendError(res, err, 'failed to list calls');
    }
  });
  callsRouter.post('/', async (req, res) => {
    try {
      const b = body(req);
      // Mock provider only — real telephony is explicitly out of scope.
      const record = await callProvider.placeCall(String(b.to ?? ''), {
        summary: b.summary as string | undefined,
        durationSec: b.durationSec === undefined ? undefined : Number(b.durationSec),
      });
      res.status(201).json(calls.log(record));
    } catch (err) {
      sendError(res, err, 'failed to place call');
    }
  });
  callsRouter.get('/:id', (req, res) => {
    try {
      res.json(calls.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get call');
    }
  });
  router.use('/calls', callsRouter);

  // ---- Threads ------------------------------------------------------------
  const threadsRouter = Router();
  threadsRouter.get('/', (_req, res) => {
    try {
      res.json(threads.list());
    } catch (err) {
      sendError(res, err, 'failed to list threads');
    }
  });
  threadsRouter.post('/', (req, res) => {
    try {
      res.status(201).json(threads.create({ title: body(req).title as string | undefined }));
    } catch (err) {
      sendError(res, err, 'failed to create thread');
    }
  });
  threadsRouter.get('/:id', (req, res) => {
    try {
      res.json(threads.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get thread');
    }
  });
  threadsRouter.patch('/:id', (req, res) => {
    try {
      res.json(threads.rename(req.params.id, String(body(req).title ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to rename thread');
    }
  });
  threadsRouter.delete('/:id', (req, res) => {
    try {
      threads.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'failed to delete thread');
    }
  });
  threadsRouter.post('/:id/messages', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(
        threads.addMessage(
          req.params.id,
          (b.role ?? 'user') as 'user' | 'assistant' | 'system',
          String(b.content ?? ''),
        ),
      );
    } catch (err) {
      sendError(res, err, 'failed to add thread message');
    }
  });
  router.use('/threads', threadsRouter);

  // ---- Research -----------------------------------------------------------
  const researchRouter = Router();
  researchRouter.post('/', async (req, res) => {
    try {
      const report = await runDeepResearch(String(body(req).query ?? ''), searchTool, research);
      res.status(201).json(report);
    } catch (err) {
      sendError(res, err, 'failed to run research');
    }
  });
  researchRouter.get('/', (_req, res) => {
    try {
      res.json(research.list());
    } catch (err) {
      sendError(res, err, 'failed to list research reports');
    }
  });
  researchRouter.get('/:id', (req, res) => {
    try {
      res.json(research.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get research report');
    }
  });
  router.use('/research', researchRouter);

  // ---- Browser (approval-gated) -------------------------------------------
  const browserRouter = Router();
  browserRouter.post('/request', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(
        browser.request({
          action: (b.action ?? '') as 'navigate' | 'extract_text' | 'screenshot',
          url: b.url as string | undefined,
        }),
      );
    } catch (err) {
      sendError(res, err, 'failed to request browser action');
    }
  });
  browserRouter.get('/approvals', (req, res) => {
    try {
      res.json(browser.list(req.query.status as 'pending' | 'approved' | 'denied' | 'executed' | undefined));
    } catch (err) {
      sendError(res, err, 'failed to list browser approvals');
    }
  });
  browserRouter.get('/approvals/:id', (req, res) => {
    try {
      res.json(browser.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get browser approval');
    }
  });
  browserRouter.post('/approvals/:id/decision', (req, res) => {
    try {
      const decision = body(req).decision;
      if (decision !== 'approved' && decision !== 'denied') {
        res.status(400).json({ error: 'decision must be "approved" or "denied"' });
        return;
      }
      res.json(browser.decide(req.params.id, decision));
    } catch (err) {
      sendError(res, err, 'failed to decide browser approval');
    }
  });
  browserRouter.post('/approvals/:id/execute', async (req, res) => {
    try {
      res.json(await browser.execute(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to execute browser action');
    }
  });
  router.use('/browser', browserRouter);

  // ---- Ideas --------------------------------------------------------------
  const ideasRouter = Router();
  ideasRouter.get('/', (req, res) => {
    try {
      res.json(ideas.list(req.query.status as 'new' | 'active' | 'done' | 'dismissed' | undefined));
    } catch (err) {
      sendError(res, err, 'failed to list ideas');
    }
  });
  ideasRouter.post('/', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(ideas.create({ title: String(b.title ?? ''), description: b.description as string | undefined }));
    } catch (err) {
      sendError(res, err, 'failed to create idea');
    }
  });
  for (const [path, op] of [
    ['/run', (id: string) => ideas.run(id)],
    ['/dismiss', (id: string) => ideas.dismiss(id)],
    ['/complete', (id: string) => ideas.complete(id)],
  ] as const) {
    ideasRouter.post(`/:id${path}`, (req, res) => {
      try {
        res.json(op(req.params.id));
      } catch (err) {
        sendError(res, err, `failed to ${path.slice(1)} idea`);
      }
    });
  }
  router.use('/ideas', ideasRouter);

  // ---- Shopping (approval-gated purchase) ---------------------------------
  const shoppingRouter = Router();
  shoppingRouter.get('/products', (req, res) => {
    try {
      res.json(searchProducts(String(req.query.q ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to search products');
    }
  });
  shoppingRouter.get('/products/:id', (req, res) => {
    try {
      res.json(getProduct(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get product');
    }
  });
  shoppingRouter.post('/carts', (_req, res) => {
    try {
      res.status(201).json(shopping.createCart());
    } catch (err) {
      sendError(res, err, 'failed to create cart');
    }
  });
  shoppingRouter.get('/carts/:id', (req, res) => {
    try {
      res.json(shopping.getCart(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get cart');
    }
  });
  shoppingRouter.post('/carts/:id/items', (req, res) => {
    try {
      const b = body(req);
      res.json(shopping.addItem(req.params.id, String(b.productId ?? ''), Number(b.qty ?? 1)));
    } catch (err) {
      sendError(res, err, 'failed to add cart item');
    }
  });
  shoppingRouter.post('/carts/:id/checkout', (req, res) => {
    try {
      // Creates a pending_approval order — the purchase completes ONLY via
      // POST /orders/:id/approve with the returned approval code.
      res.status(201).json(shopping.checkout(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to checkout cart');
    }
  });
  shoppingRouter.get('/orders/:id', (req, res) => {
    try {
      res.json(shopping.getOrder(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get order');
    }
  });
  shoppingRouter.post('/orders/:id/approve', (req, res) => {
    try {
      res.json(shopping.approveOrder(req.params.id, String(body(req).code ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to approve order');
    }
  });
  shoppingRouter.post('/orders/:id/cancel', (req, res) => {
    try {
      res.json(shopping.cancelOrder(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to cancel order');
    }
  });
  router.use('/shopping', shoppingRouter);

  // ---- Places -------------------------------------------------------------
  const placesRouter = Router();
  placesRouter.get('/search', (req, res) => {
    try {
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      res.json(places.searchPlaces(String(req.query.q ?? ''), limit === undefined ? {} : { limit }));
    } catch (err) {
      sendError(res, err, 'failed to search places');
    }
  });
  placesRouter.get('/:id', (req, res) => {
    try {
      res.json(places.getPlace(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get place');
    }
  });
  placesRouter.get('/:id/map', (req, res) => {
    try {
      res.json(mapWidgetPayload(places.getPlace(req.params.id)));
    } catch (err) {
      sendError(res, err, 'failed to build map widget');
    }
  });
  router.use('/places', placesRouter);

  // ---- Social -------------------------------------------------------------
  const socialRouter = Router();
  socialRouter.get('/watchlist', (_req, res) => {
    try {
      res.json(watchlist.list());
    } catch (err) {
      sendError(res, err, 'failed to list watchlist');
    }
  });
  socialRouter.post('/watchlist', (req, res) => {
    try {
      res.status(201).json(watchlist.add(String(body(req).keyword ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to add watchlist keyword');
    }
  });
  socialRouter.delete('/watchlist/:id', (req, res) => {
    try {
      watchlist.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'failed to remove watchlist keyword');
    }
  });
  socialRouter.get('/digest', async (_req, res) => {
    try {
      const digest = await buildDigest(watchlist.list(), socialSearch);
      res.json({ digest, markdown: renderDigestMarkdown(digest) });
    } catch (err) {
      sendError(res, err, 'failed to build social digest');
    }
  });
  router.use('/social', socialRouter);

  // ---- Meetings (meeting-notes pipeline) ----------------------------------
  // POST /upload { fileName, audioBase64, title? } → transcribe → summarize
  // via agent → save as Page → audio bytes are never persisted (privacy).
  const meetings = new MeetingStore(mdb);
  const pages = new PageStore(dataDir);
  const meetingsRouter = Router();

  meetingsRouter.get('/', (_req, res) => {
    try {
      res.json(meetings.list());
    } catch (err) {
      sendError(res, err, 'failed to list meetings');
    }
  });

  meetingsRouter.post('/upload', async (req, res) => {
    try {
      const b = body(req);
      const fileName = String(b.fileName ?? '');
      const audioBase64 = String(b.audioBase64 ?? '');
      if (!audioBase64) {
        res.status(400).json({ error: 'audioBase64 is required' });
        return;
      }
      const audio = Buffer.from(audioBase64, 'base64');
      validateAudioFile(fileName, audio.length);

      // 1. Transcribe (mock STT by default; real provider when wired).
      const stt = new MockSTTProvider();
      const { text: transcript, durationMs } = await transcribeMeetingAudio(stt, audio, fileName);

      // 2. Summarize via the agent runtime.
      const bot = deps.bots[0];
      if (!bot) {
        res.status(503).json({ error: 'no bots configured' });
        return;
      }
      let summaryJson = '';
      await deps.agentRuntime.runTurn({
        bot,
        message: meetingSummaryPrompt(transcript),
        sessionId: `meeting-${Date.now()}`,
        onEvent: async (event) => {
          if (event.type === 'token') summaryJson += event.content;
        },
      });
      const summary = parseMeetingSummary(summaryJson);

      // 3. Save as a Page.
      const date = new Date().toISOString().slice(0, 10);
      const title = String(b.title ?? '').trim() || `Meeting notes — ${date}`;
      const markdown = renderMeetingNotesMarkdown({ title, date, transcript, summary });
      const page = pages.create({ title, content: markdown, createdBy: 'meetings' });

      // 4. Audio is never written to disk — the Buffer above is the only copy
      //    and it goes out of scope here (privacy, like Space's plugin).
      const meeting = meetings.record({ title, pageId: page.id, fileName, durationMs });
      res.status(201).json({ meeting, pageId: page.id, summary });
    } catch (err) {
      sendError(res, err, 'failed to process meeting audio');
    }
  });
  router.use('/meetings', meetingsRouter);

  // ---- Slides (slide deck builder) ----------------------------------------
  const slides = new SlideDeckStore(mdb);
  const slidesRouter = Router();

  slidesRouter.get('/', (_req, res) => {
    try {
      res.json(slides.list());
    } catch (err) {
      sendError(res, err, 'failed to list slide decks');
    }
  });

  slidesRouter.post('/', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(slides.create({ title: String(b.title ?? ''), slides: (b.slides as never[]) ?? [] }));
    } catch (err) {
      sendError(res, err, 'failed to create slide deck');
    }
  });

  slidesRouter.get('/:id', (req, res) => {
    try {
      res.json(slides.get(req.params.id));
    } catch (err) {
      sendError(res, err, 'failed to get slide deck');
    }
  });

  slidesRouter.put('/:id', (req, res) => {
    try {
      const b = body(req);
      res.json(
        slides.update(req.params.id, {
          title: b.title !== undefined ? String(b.title) : undefined,
          slides: b.slides !== undefined ? ((b.slides as never[]) ?? []) : undefined,
        }),
      );
    } catch (err) {
      sendError(res, err, 'failed to update slide deck');
    }
  });

  slidesRouter.delete('/:id', (req, res) => {
    try {
      slides.delete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'failed to delete slide deck');
    }
  });

  slidesRouter.post('/:id/export', (req, res) => {
    try {
      const deck = slides.get(req.params.id);
      const format = String(body(req).format ?? 'html');
      if (format === 'markdown' || format === 'md') {
        res.json({ format: 'markdown', content: exportDeckMarkdown(deck) });
      } else {
        res.json({ format: 'html', content: exportDeckHtml(deck) });
      }
    } catch (err) {
      sendError(res, err, 'failed to export slide deck');
    }
  });
  router.use('/slides', slidesRouter);

  // ---- Knowledge base (RAG over user documents, Octop parity) ------------
  // Local-first: trigram-hash embeddings, zero API keys. Document bytes are
  // never persisted — text is extracted at ingest and the buffer dropped.
  const kb = new KnowledgeBaseStore(mdb, new LocalEmbedder());
  const kbRouter = Router();

  // Raw binary upload (up to 50MB). The global express.json (1mb) only
  // parses application/json, so this octet-stream parser does not conflict.
  kbRouter.post(
    '/documents',
    express.raw({ limit: '55mb', type: 'application/octet-stream' }),
    async (req, res) => {
      try {
        const buf = req.body as Buffer;
        if (!buf || buf.length === 0) {
          res.status(400).json({ error: 'empty upload body' });
          return;
        }
        if (buf.length > 50 * 1024 * 1024) {
          res.status(413).json({ error: 'file too large (max 50MB)' });
          return;
        }
        const fileName = String(req.query.fileName ?? 'upload').slice(0, 200);
        const title = String(req.query.title ?? '').slice(0, 200) || fileName;
        const mimeType = String(req.query.mimeType ?? '').slice(0, 100);
        const corpusId = typeof req.query.corpusId === 'string' ? req.query.corpusId : null;
        const text = extractText(fileName, mimeType, buf);
        if (!text.trim()) {
          res.status(422).json({ error: 'no extractable text (scanned/image PDFs need OCR)' });
          return;
        }
        const doc = await kb.addDocument({ title, fileName, mimeType, text, corpusId });
        res.status(201).json(doc);
      } catch (err) {
        sendError(res, err, 'failed to ingest document');
      }
    },
  );

  kbRouter.get('/documents', (req, res) => {
    try {
      const corpusId = typeof req.query.corpusId === 'string' ? req.query.corpusId : undefined;
      res.json(kb.listDocuments(corpusId));
    } catch (err) {
      sendError(res, err, 'failed to list documents');
    }
  });

  kbRouter.delete('/documents/:id', (req, res) => {
    try {
      kb.deleteDocument(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'failed to delete document');
    }
  });

  kbRouter.post('/query', async (req, res) => {
    try {
      const b = body(req);
      const chunks = await kb.query({
        query: String(b.query ?? ''),
        topK: typeof b.topK === 'number' ? b.topK : 5,
        corpusIds: Array.isArray(b.corpusIds) ? (b.corpusIds as string[]) : undefined,
      });
      res.json({ chunks });
    } catch (err) {
      sendError(res, err, 'failed to query knowledge base');
    }
  });

  // Retrieval + LLM synthesis with inline [n] citations.
  kbRouter.post('/answer', async (req, res) => {
    try {
      const b = body(req);
      const question = String(b.query ?? '').trim();
      if (!question) {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const topK = typeof b.topK === 'number' ? Math.min(Math.max(b.topK, 1), 10) : 5;
      const corpusIds = Array.isArray(b.corpusIds) ? (b.corpusIds as string[]) : undefined;
      const chunks = await kb.query({ query: question, topK, corpusIds });
      if (chunks.length === 0) {
        res.json({ answer: 'I found no relevant documents in the knowledge base.', chunks: [] });
        return;
      }
      const bot = deps.bots[0];
      if (!bot) {
        res.status(503).json({ error: 'no bots configured' });
        return;
      }
      const prompt =
        `Answer the question using ONLY the sources below. Cite every factual claim inline as [1], [2], etc. ` +
        `If the sources do not contain the answer, say so.\n\nQuestion: ${question}\n\nSources:\n${formatCitedSources(chunks)}`;
      let answer = '';
      await deps.agentRuntime.runTurn({
        bot,
        message: prompt,
        sessionId: `kb-answer-${Date.now()}`,
        onEvent: async (event) => {
          if (event.type === 'token') answer += event.content;
        },
      });
      res.json({ answer: appendSourcesSection(answer, chunks), chunks });
    } catch (err) {
      sendError(res, err, 'failed to answer from knowledge base');
    }
  });

  kbRouter.get('/corpora', (_req, res) => {
    try {
      res.json(kb.listCorpora());
    } catch (err) {
      sendError(res, err, 'failed to list corpora');
    }
  });

  kbRouter.post('/corpora', (req, res) => {
    try {
      const b = body(req);
      res.status(201).json(kb.createCorpus(String(b.name ?? ''), String(b.description ?? '')));
    } catch (err) {
      sendError(res, err, 'failed to create corpus');
    }
  });

  kbRouter.delete('/corpora/:id', (req, res) => {
    try {
      kb.deleteCorpus(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'failed to delete corpus');
    }
  });

  router.use('/kb', kbRouter);
}
