// SPDX-License-Identifier: Apache-2.0
// Tests for KB hybrid search (vector + FTS5/BM25 + RRF), plus a small
// recall@5 evaluation: vector-only vs hybrid on a 15-doc fixture with
// known relevant queries. Fully offline — LocalEmbedder + node:sqlite.

import { describe, it, expect, beforeAll } from 'vitest';
import { ModuleDb } from '../db.js';
import {
  KnowledgeBaseStore,
  LocalEmbedder,
  MockEmbedder,
  type KbRetrievedChunk,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixture: 15 single-chunk docs on distinct topics
// ---------------------------------------------------------------------------

const DOCS: Array<{ title: string; text: string }> = [
  {
    title: 'PostgreSQL connection pooling',
    text: 'PgBouncer is a lightweight connection pooler for PostgreSQL. Run it in transaction pooling mode so each client connection reuses a small pool of server connections. Key settings: max_client_conn caps incoming clients, default_pool_size bounds server connections per database, and reserve_pool_size absorbs bursts. Point your app at PgBouncer port 6432 instead of PostgreSQL directly. Monitor SHOW POOLS for waiters; waiting clients mean the pool is saturated and you should raise default_pool_size or add read replicas.',
  },
  {
    title: 'Sourdough bread baking',
    text: 'A sourdough starter is a live culture of wild yeast and lactobacilli. Feed it equal weights of flour and water twice a day at room temperature until it reliably doubles within six hours. For the dough, aim for 75 percent hydration: 750 grams of water per 1000 grams of flour, plus 20 grams of salt. Bulk ferment with coil folds every half hour, then cold-proof the shaped loaf overnight. Bake in a preheated Dutch oven at 250C for twenty minutes with the lid on, then twenty more with it off.',
  },
  {
    title: 'Kubernetes pod autoscaling',
    text: 'The Horizontal Pod Autoscaler adjusts replica counts from observed metrics. Install metrics-server, then define an HPA targeting CPU utilization at 70 percent: kubectl autoscale deployment web --cpu-percent=70 --min=2 --max=10. The controller recomputes desiredReplicas from the ratio of current to target utilization every fifteen seconds, honoring stabilization windows so flapping is avoided. For custom signals like queue depth, wire Prometheus Adapter and scale on an external metric instead of CPU.',
  },
  {
    title: 'Espresso extraction guide',
    text: 'Dial in espresso with a 1:2 brew ratio: dose 18 grams of finely ground coffee and pull 36 grams of liquid espresso in 25 to 30 seconds. If the shot runs fast and tastes sour, grind finer; if it chokes and tastes bitter, grind coarser. Keep brew temperature near 93C and tamp level with about 15 kilograms of pressure. WDT with a needle distributor breaks up clumps for even extraction. Taste is the final judge: sweetness with no harsh dryness means the grind is right.',
  },
  {
    title: 'TypeScript generics',
    text: 'Generics let functions work over many types while staying type-safe. Write function identity<T>(value: T): T to echo any type. Constrain a type parameter with extends: <T extends { length: number }> accepts only things with a length property. Use keyof for type-safe property access: function get<T, K extends keyof T>(obj: T, key: K). Default type arguments like <T = string> and conditional types such as T extends U ? X : Y compose into expressive, reusable type-level programs.',
  },
  {
    title: 'Tokyo subway navigation',
    text: 'Tokyo has two subway operators, Tokyo Metro and Toei, plus JR lines, all with separate fares. Buy a Suica or Pasmo IC card and tap in and out; transfers between operators charge a new base fare. Route with the Japan Travel app: it shows the platform number, car position for fast transfers, and the exact yen fare. Avoid Shinjuku and Shibuya stations at rush hour if you can. Last trains depart around midnight, and taxis after that are expensive.',
  },
  {
    title: 'Beekeeping basics',
    text: 'Start with a Langstroth hive, a smoker, and a veil. Install a nucleus colony in spring, placing frames of brood in the center of the bottom box. Inspect every ten days in season: look for the queen or fresh eggs, check honey stores, and watch for varroa mites with a sugar-shake test. Bees abscond when the hive is too hot, queenless, or harassed by pests, so give them shade, space, and a calm hand. Harvest only surplus honey, leaving at least one full box for winter.',
  },
  {
    title: 'GraphQL vs REST',
    text: 'REST exposes fixed endpoints like GET /users/:id, which often over-fetch or force multiple round trips. GraphQL exposes a single endpoint where the client names exactly the fields it wants, so one query can fetch a user, their posts, and each post comment count. That flexibility costs you: caching, rate limiting, and query-complexity analysis are harder than with REST. Choose GraphQL for client-driven mobile apps with varied screens; keep REST for simple CRUD services and public webhooks.',
  },
  {
    title: 'Mediterranean diet',
    text: 'The Mediterranean diet centers on vegetables, legumes, whole grains, fish, and olive oil as the primary fat. Red meat appears only a few times a month; herbs and lemon replace heavy salt. Large cohort studies link the pattern to lower cardiovascular risk and slower cognitive decline, likely from monounsaturated fats and polyphenols rather than any single superfood. A practical start: cook with olive oil, eat fish twice a week, snack on nuts, and make half your plate vegetables.',
  },
  {
    title: 'Docker multi-stage builds',
    text: 'Multi-stage builds keep production images small. In the first stage use a full SDK image to compile: FROM golang:1.22 AS build, then go build -o app. In the final stage copy only the binary into a minimal base: FROM gcr.io/distroless/static and COPY --from=build /src/app /app. The result drops from hundreds of megabytes to tens, with no compiler toolchain for attackers to abuse. Name stages with AS and reference them with --from; unreachable stages are skipped entirely.',
  },
  {
    title: 'Birdwatching in wetlands',
    text: 'Wetlands reward patience and a spotting scope. Arrive at dawn when rails and bitterns call from the reeds. Scan mudflats on a falling tide for sandpipers probing the exposed edge. Learn flight silhouettes: harriers glide low with wings in a shallow V, while ducks fly fast and direct. Keep a field notebook of date, tide, and weather; patterns emerge across seasons. Stay on boardwalks during nesting season so you never flush birds off nests.',
  },
  {
    title: 'Rust ownership model',
    text: 'Rust enforces memory safety without a garbage collector through ownership: each value has exactly one owner, and the value is dropped when the owner goes out of scope. The borrow checker then enforces two rules: any number of immutable references OR exactly one mutable reference, and references must never outlive their referent. Move semantics transfer ownership; Clone duplicates explicitly. Lifetimes annotate how long references stay valid. Fight the borrow checker by restructuring data, not by sprinkling clone everywhere.',
  },
  {
    title: 'French press coffee',
    text: 'French press is full-immersion brewing: coarse grounds steep directly in hot water. Use a 1:15 ratio, 30 grams of coffee to 450 grams of water at 96C. Stir after one minute to break the crust, skim the foam, then steep four minutes total before pressing slowly. A coarse, even grind keeps silt out of the cup. The result is heavy-bodied with pronounced oils, since no paper filter strips them away.',
  },
  {
    title: 'Nginx reverse proxy',
    text: 'Put Nginx in front of your app with a reverse proxy block: location / { proxy_pass http://127.0.0.1:3000; }. Forward client context with proxy_set_header X-Real-IP $remote_addr and X-Forwarded-For $proxy_add_x_forwarded_for so the backend sees real addresses. Terminate TLS at Nginx with ssl_certificate and ssl_certificate_key, then proxy plain HTTP upstream. Add proxy_cache for static responses and limit_req to blunt brute-force login attempts.',
  },
  {
    title: 'Indoor plant care',
    text: 'Most houseplants die from overwatering, not neglect. Water only when the top two centimeters of soil are dry, and always let pots drain; roots sitting in water rot within days. Match light to species: succulents want a south window, ferns prefer bright indirect light. Wipe dusty leaves monthly so they can photosynthesize, and repot when roots circle the drainage holes. In winter, growth stalls, so halve both water and fertilizer.',
  },
];

const QUERIES: Array<{ q: string; relevant: string[]; note: string }> = [
  { q: 'PgBouncer transaction pooling settings', relevant: ['PostgreSQL connection pooling'], note: 'exact rare terms' },
  { q: 'how to keep a sourdough starter alive', relevant: ['Sourdough bread baking'], note: 'paraphrase + exact term' },
  { q: 'scale pods automatically from CPU load', relevant: ['Kubernetes pod autoscaling'], note: 'paraphrase (autoscale vs autoscaling)' },
  { q: 'espresso 18 grams in 36 grams out', relevant: ['Espresso extraction guide'], note: 'exact ratio terms' },
  { q: 'TypeScript generic constraints with extends', relevant: ['TypeScript generics'], note: 'exact terms' },
  { q: 'changing trains between Tokyo Metro and Toei', relevant: ['Tokyo subway navigation'], note: 'exact operator names' },
  { q: 'why did my bees abandon their hive', relevant: ['Beekeeping basics'], note: 'paraphrase (abscond)' },
  { q: 'when to choose GraphQL over REST', relevant: ['GraphQL vs REST'], note: 'exact terms' },
  { q: 'olive oil diet for heart health', relevant: ['Mediterranean diet'], note: 'paraphrase' },
  { q: 'smaller production Docker images with build stages', relevant: ['Docker multi-stage builds'], note: 'paraphrase' },
  { q: 'rust borrow checker mutable reference rules', relevant: ['Rust ownership model'], note: 'exact terms' },
  { q: 'nginx proxy_pass and X-Forwarded-For headers', relevant: ['Nginx reverse proxy'], note: 'exact config terms' },
  { q: 'coffee brewing methods compared', relevant: ['Espresso extraction guide', 'French press coffee'], note: 'two relevant docs' },
];

let mdb: ModuleDb;
let kb: KnowledgeBaseStore;

beforeAll(async () => {
  mdb = new ModuleDb(':memory:');
  kb = new KnowledgeBaseStore(mdb, new LocalEmbedder());
  for (const d of DOCS) {
    await kb.addDocument({ title: d.title, fileName: `${d.title}.md`, mimeType: 'text/markdown', text: d.text });
  }
}, 60000);

function recallAtK(ranked: string[], relevant: string[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  const hits = relevant.filter((t) => top.has(t)).length;
  return relevant.length === 0 ? 1 : hits / relevant.length;
}

describe('KB hybrid search', () => {
  it('query() stays vector-only by default (backward compat)', async () => {
    const chunks = await kb.query({ query: 'PgBouncer', topK: 5 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).not.toHaveProperty('sources'); // plain KbRetrievedChunk
    expect(chunks[0].documentTitle).toBe('PostgreSQL connection pooling');
  });

  it('query({ hybrid: true }) fuses vector + BM25 with RRF', async () => {
    const hits = await kb.query({ query: 'PgBouncer transaction pooling', topK: 5, hybrid: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].documentTitle).toBe('PostgreSQL connection pooling');
    const withSources = hits as Array<KbRetrievedChunk & { sources?: string[] }>;
    expect(withSources[0].sources).toBeDefined();
    expect(withSources[0].sources).toContain('lexical');
  });

  it('queryHybrid() returns fused scores and source legs', async () => {
    const hits = await kb.queryHybrid({ query: 'borrow checker', topK: 5 });
    expect(hits[0].documentTitle).toBe('Rust ownership model');
    expect(hits[0].sources).toContain('lexical');
    expect(hits[0].sources).toContain('vector');
    // RRF scores are small positive numbers, not cosines near 1
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThan(1);
  });

  it('lexical leg finds exact config tokens the vector leg can miss', async () => {
    // "proxy_pass" is an exact token; BM25 ranks it first even if the
    // trigram vector prefers another doc.
    const hits = await kb.queryHybrid({ query: 'proxy_pass', topK: 5 });
    expect(hits[0].documentTitle).toBe('Nginx reverse proxy');
    expect(hits[0].sources).toContain('lexical');
  });

  it('respects corpus scoping on both legs', async () => {
    const corpus = kb.createCorpus('coffee', 'coffee docs');
    const doc = await kb.addDocument({
      title: 'Cold brew',
      fileName: 'cold-brew.md',
      mimeType: 'text/markdown',
      text: 'Cold brew steeps coarse coffee grounds in cold water for twelve to twenty-four hours, producing a smooth low-acid concentrate.',
      corpusId: corpus.id,
    });
    void doc;
    const hits = await kb.queryHybrid({ query: 'coffee', topK: 5, corpusIds: [corpus.id] });
    expect(hits.length).toBe(1);
    expect(hits[0].documentTitle).toBe('Cold brew');
    kb.deleteCorpus(corpus.id);
  });

  it('deleteDocument removes chunks from the lexical leg too', async () => {
    const doc = await kb.addDocument({
      title: 'Ephemeral doc',
      fileName: 'ephemeral.md',
      mimeType: 'text/markdown',
      text: 'Zzxqyplugh is a completely unique token that appears nowhere else in this fixture.',
    });
    const before = await kb.queryHybrid({ query: 'Zzxqyplugh', topK: 5 });
    expect(before[0].documentTitle).toBe('Ephemeral doc');
    kb.deleteDocument(doc.id);
    const after = await kb.queryHybrid({ query: 'Zzxqyplugh', topK: 5 });
    expect(after.some((h) => h.documentTitle === 'Ephemeral doc')).toBe(false);
  });

  it('vector-only and hybrid agree on empty stores / bad queries', async () => {
    const empty = new KnowledgeBaseStore(new ModuleDb(':memory:'), new MockEmbedder());
    expect(await empty.query({ query: 'anything' })).toEqual([]);
    expect(await empty.queryHybrid({ query: 'anything' })).toEqual([]);
    await expect(kb.query({ query: '   ' })).rejects.toThrow(/query is required/);
    await expect(kb.queryHybrid({ query: '   ' })).rejects.toThrow(/query is required/);
  });
});

describe('recall@5 evaluation: vector-only vs hybrid', () => {
  it('measures recall@5 for both paths (hybrid must not regress)', async () => {
    const K = 5;
    const rows: Array<{ q: string; vec: number; hyb: number; note: string }> = [];
    for (const { q, relevant, note } of QUERIES) {
      const vecTitles = (await kb.query({ query: q, topK: K })).map((c: KbRetrievedChunk) => c.documentTitle);
      const hybTitles = (await kb.queryHybrid({ query: q, topK: K })).map((c) => c.documentTitle);
      rows.push({ q, vec: recallAtK(vecTitles, relevant, K), hyb: recallAtK(hybTitles, relevant, K), note });
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const vecMean = mean(rows.map((r) => r.vec));
    const hybMean = mean(rows.map((r) => r.hyb));

    // Printable report (also saved to hybrid-recall-eval.md for the record).
    const lines = [
      `recall@${K} over ${QUERIES.length} queries × ${DOCS.length} docs (LocalEmbedder, deterministic)`,
      '',
      '| query | vector-only | hybrid | note |',
      '|---|---|---|---|',
      ...rows.map(
        (r) => `| ${r.q} | ${r.vec.toFixed(2)} | ${r.hyb.toFixed(2)} | ${r.note} |`,
      ),
      '',
      `| **mean** | **${vecMean.toFixed(3)}** | **${hybMean.toFixed(3)}** | |`,
    ];
    console.log('\n' + lines.join('\n') + '\n');

    expect(hybMean).toBeGreaterThanOrEqual(vecMean);
    expect(hybMean).toBeGreaterThan(0);
  }, 60000);
});
