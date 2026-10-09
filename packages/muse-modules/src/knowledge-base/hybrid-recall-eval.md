# Hybrid search recall evaluation

Fixture: 15 single-chunk documents on distinct topics (PostgreSQL pooling,
sourdough, Kubernetes autoscaling, espresso, TypeScript generics, Tokyo
subway, beekeeping, GraphQL vs REST, Mediterranean diet, Docker multi-stage,
wetlands birdwatching, Rust ownership, French press, Nginx proxy, indoor
plants) × 13 queries with known relevant documents (12 single-relevant, 1
with two relevant docs). Embedder: `LocalEmbedder` (char-trigram hash, 384d,
deterministic — no network). Metric: recall@5. RRF k=60.

Source: `hybrid-search.test.ts` → "recall@5 evaluation" (run with
`npx vitest run src/knowledge-base/hybrid-search.test.ts`).

| query | vector-only | hybrid | note |
|---|---|---|---|
| PgBouncer transaction pooling settings | 1.00 | 1.00 | exact rare terms |
| how to keep a sourdough starter alive | 1.00 | 1.00 | paraphrase + exact term |
| scale pods automatically from CPU load | 1.00 | 1.00 | paraphrase (autoscale vs autoscaling) |
| espresso 18 grams in 36 grams out | 1.00 | 1.00 | exact ratio terms |
| TypeScript generic constraints with extends | 1.00 | 1.00 | exact terms |
| changing trains between Tokyo Metro and Toei | 1.00 | 1.00 | exact operator names |
| why did my bees abandon their hive | 1.00 | 1.00 | paraphrase (abscond) |
| when to choose GraphQL over REST | 1.00 | 1.00 | exact terms |
| olive oil diet for heart health | 1.00 | 1.00 | paraphrase |
| smaller production Docker images with build stages | 1.00 | 1.00 | paraphrase |
| rust borrow checker mutable reference rules | 1.00 | 1.00 | exact terms |
| nginx proxy_pass and X-Forwarded-For headers | 1.00 | 1.00 | exact config terms |
| coffee brewing methods compared | 0.50 | 1.00 | two relevant docs |

| **mean recall@5** | **0.962** | **1.000** | |

Reading: on this fixture the trigram-hash vector leg is already strong
(mean 0.962); hybrid search (vector + FTS5/BM25 + RRF k=60) never regresses
and recovers the second relevant document on the multi-relevant query
("coffee brewing methods compared": vector-only surfaced only one of the two
coffee docs in the top 5; the BM25 leg ranked "French press coffee" higher
and RRF fusion promoted it). Hybrid is a strict improvement here: no query
got worse, one got better.
