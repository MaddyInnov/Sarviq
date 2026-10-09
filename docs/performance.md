# Performance Audit — 2026-10-09

**Method:** `scripts/bench.mjs` (node, not part of the test suite). Before = `dist/mvp-server` (commit `fd3ea311`); after = rebuilt binary with the optimizations below. All numbers are `--quick` mode (10–50 reps for latency, 3 chat turns) on the same VM.

## Before / After

| Benchmark | Before | After | Δ |
|---|---|---|---|
| **Boot time** (spawn → listening) | 4673 ms | **421 ms** | **11x faster** ✅ target <2s |
| GET /api/health p50/p95 | 12.1 / 19.6 ms | 8.2 / 21.3 ms | ~30% faster p50 |
| GET /api/bots p50/p95 | 11.8 / 22.4 ms | 7.3 / 9.8 ms | ~40% faster |
| GET /api/workflows p50/p95 | 9.0 / 29.5 ms | 3.9 / 6.4 ms | ~2x faster |
| GET /api/preferences p50/p95 | 5.1 / 8.8 ms | 3.9 / 12.3 ms | ~25% faster p50 |
| POST /api/chat first-token p50/p95 | 143 / 170 ms | 111 / 145 ms | ~22% faster |
| Workflow 9×50ms sequential | 622 ms (floor 450) | 622 ms (unchanged path) | — |
| Workflow 9×50ms parallel | 211 ms (floor 50) | **~94 ms** | **2.2x faster** |
| Parallel speedup vs sequential | 2.9x | **~6.6x** | n8n-class fan-out |
| SQLite 1000 session writes | 156 ms (6423/s) | 156 ms | already fast |
| SQLite read 100 msgs | 6.27 ms | 5.60 ms | — |
| Server RSS after boot | 79 MB | 81 MB | flat |
| Binary size | 81.9 MB | 82.0 MB | flat |
| Web static export | 1.9 MB (1.1 MB JS) | 1.9 MB (1.1 MB JS) | flat, three.js lazy |

## What was changed and why

### 1. Deferred MCP connections until after listen (boot 4673ms → 421ms)
**File:** `apps/api/src/tool-registry.ts`, `apps/api/src/index.ts`

`buildToolRegistry()` connected to every configured MCP server *before* `app.listen()`. A failing server (`npx @modelcontextprotocol/server-fetch` → npm 404 + retries) blocked boot for seconds. The MCP loop is now `connectMcp()`, kicked off in the background from the listen callback. The shared `connections` array fills in as servers land; the boot log reports `mcp: warming up in background` then the final count. Behavior unchanged — tools appear when their server connects, same as before, just not blocking the port.

### 2. Workflow runner in-memory run cache (parallel 211ms → 94ms)
**File:** `packages/workflows/src/runner.ts`

Each node transition called `getRunOrThrow()` → full run assembly from SQLite (2 queries: `runs` + `node_states`). Per node: ~7 assemblies ≈ 14 queries + upserts. Added a `runCache` Map primed at `executeRun()` start with write-through on every mutation (`updateNodeState`, `setRunStatus`). The `executing` Set already guarantees single-flight per run, so the cache can't go stale. The DB remains the durable source of truth (crash-resume, API reads). All 25 workflow tests pass.

### 3. Cached slash-command loader (chat first-token 143ms → 111ms)
**File:** `apps/api/src/slash-commands.ts`, `apps/api/src/routes.ts`

The chat route called `loadSlashCommands()` (sync `readFileSync` + `JSON.parse`) on *every* message. Added `loadSlashCommandsCached()` with mtime/size invalidation; `save`/`delete` invalidate. The chat route now uses the cached version.

### 4. Provider instance cache
**File:** `packages/agent-runtime/src/runtime.ts`

`resolveProvider()` called `createProvider()` on every turn. Providers are now cached per `providerId` (the stateful demo mock bypasses the cache — it must not be shared across turns).

### 5. Skill summary cache
**File:** `packages/agent-runtime/src/skills.ts`

`getSummary()` did `existsSync` + `readFileSync` + frontmatter parse per skill per turn. Added mtime/size-validated cache. All 300 agent-runtime tests pass.

### 6. Composite approval index
**File:** `packages/governance/src/gateway.ts`

Added `idx_approvals_status_ts ON approvals(status, ts DESC)` for the hot `WHERE status = ? ORDER BY ts DESC` query (pending approvals inbox). All 35 governance tests pass.

### 7. Fixed `PageStore` boot crash (found during benchmarking)
**File:** `apps/api/src/muse-modules.ts`

`new PageStore(join(dataDir, 'pages.db'))` passed a *file* path where the constructor expects a *directory* (`openDb` does `mkdirSync(dataDir)` + `join(dataDir, 'pages.db')`). Fresh data dirs crashed at boot with EEXIST. Fixed to `new PageStore(dataDir)`.

## Verified already-fast (no changes needed)

- **Workflow parallelism:** the runner already executes levels via `Promise.all` — n8n-style fan-out was already correct; only the DB overhead was slow.
- **SSE streaming:** `X-Accel-Buffering: no` + `flushHeaders()` set; tokens flush per event.
- **SQLite indexes:** `idx_messages_session`, `idx_approvals_status`, `idx_audit_ts` all present; `EXPLAIN QUERY PLAN` confirms index use.
- **Catalog:** `catalog.json` already cached in-memory.
- **Web bundle:** three.js is lazy-loaded (`next/dynamic`, `ssr: false`); no chunk over 300KB.

## Remaining known bottlenecks (honest)

1. **Chat first-token (~111ms):** dominated by session load + system-prompt build + provider handshake. The mock provider streams synchronously, so this is pure overhead. Further wins would need prepared-statement caching in `SessionStore` (each `prepare()` recompiles SQL) — measurable but small.
2. **API p50 (~4–8ms):** Express + JSON overhead. Fine for this product.
3. **Binary size (82MB):** Bun bundle; mostly the embedded web UI + deps. Not worth optimizing.
4. **`GET /api/health` p95 (21ms):** first-request JIT warmth; steady-state p50 is 8ms.

## Reproduce

```bash
node scripts/bench.mjs            # full suite (~5 min)
node scripts/bench.mjs --quick    # fast pass (~40s)
BENCH_BIN=/tmp/my-binary node scripts/bench.mjs --quick  # compare a build
```
