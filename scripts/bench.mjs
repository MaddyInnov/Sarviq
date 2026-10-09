// SPDX-License-Identifier: Apache-2.0
// Performance benchmarks for the MVP. NOT part of the test suite.
// Usage: node scripts/bench.mjs [--quick]
//   --quick skips the slower benchmarks (memory soak, full latency sweeps).
//
// Measures: boot time, API latency (p50/p95), workflow throughput,
// SQLite write performance, memory footprint, bundle sizes.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const QUICK = process.argv.includes('--quick');

const results = {};
function report(name, value, unit = '') {
  results[name] = { value, unit };
  console.log(`  ${name}: ${value}${unit}`);
}

/** p50/p95 of an array of ms durations. */
function pct(durations) {
  const s = [...durations].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { p50: q(50), p95: q(95), n: s.length };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 1. Boot time
// ---------------------------------------------------------------------------
async function benchBoot() {
  console.log('\n[1] Binary boot time');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-data-'));
  const port = 4187;
  const binPath = process.env.BENCH_BIN || path.join(repo, 'dist', 'mvp-server');
  const t0 = performance.now();
  const child = spawn(binPath, [], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, DEMO_MOCK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootMs = -1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('boot timeout (60s)')), 60000);
    const onData = (d) => {
      const s = d.toString();
      if (s.includes('listening on') && bootMs < 0) {
        bootMs = performance.now() - t0;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
  report('boot_ms', Math.round(bootMs), 'ms');
  return { child, port, dataDir };
}

async function waitForHealth(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('health check never became ready');
}

// ---------------------------------------------------------------------------
// 2. API latency
// ---------------------------------------------------------------------------
async function benchLatency(port) {
  console.log('\n[2] API latency (p50/p95 ms)');
  await waitForHealth(port);
  const reps = QUICK ? 10 : 50;

  async function timeGet(p) {
    const ds = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      await r.text();
      ds.push(performance.now() - t0);
    }
    return pct(ds);
  }

  for (const p of ['/api/health', '/api/bots', '/api/workflows', '/api/preferences']) {
    const { p50, p95 } = await timeGet(p);
    report(`GET ${p}`, `${p50.toFixed(1)}/${p95.toFixed(1)}`, 'ms p50/p95');
  }

  // Chat first-token time with the demo mock provider (no real LLM, no keys).
  const chatReps = QUICK ? 3 : 10;
  const firstTokens = [];
  for (let i = 0; i < chatReps; i++) {
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        botId: 'helper',
        message: `bench ping ${i}`,
        sessionId: `bench-${i}`,
        provider: 'demo',
      }),
    });
    if (!r.ok || !r.body) throw new Error(`chat failed: ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstTokenMs = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE frames end with \n\n
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if ((ev.type === 'token' || ev.type === 'done' || ev.type === 'error') && firstTokenMs < 0) {
              firstTokenMs = performance.now() - t0;
            }
          } catch {}
        }
        if (firstTokenMs >= 0) break;
      }
      if (firstTokenMs >= 0) break;
    }
    try { await reader.cancel(); } catch {}
    if (firstTokenMs < 0) throw new Error('no token event received');
    firstTokens.push(firstTokenMs);
  }
  const { p50, p95 } = pct(firstTokens);
  report('POST /api/chat first-token', `${p50.toFixed(0)}/${p95.toFixed(0)}`, 'ms p50/p95');
}

// ---------------------------------------------------------------------------
// 3. Workflow throughput (in-process, compiled dist)
// ---------------------------------------------------------------------------
async function benchWorkflows() {
  console.log('\n[3] Workflow throughput (in-process)');
  const { WorkflowRunner } = await import('../packages/workflows/dist/runner.js');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-wf-')), 'wf.db');

  // Stub agent runtime / governance / tools: no LLM, no approvals.
  const stubRuntime = { runTurn: async () => {} };
  const stubGovernance = {
    evaluate: async () => ({ effect: 'allow' }),
    requestApproval: () => 'bench-approval',
    awaitDecision: async () => 'approved',
  };
  const tools = new Map([
    ['noop', { name: 'noop', description: 'noop', handler: async () => ({ ok: true }) }],
  ]);
  const runner = new WorkflowRunner({
    dbPath,
    agentRuntime: stubRuntime,
    governance: stubGovernance,
    tools,
    bots: new Map(),
  });

  function delayNode(id, seconds) {
    return { id, type: 'delay', config: { seconds } };
  }

  // Sequential chain: trigger -> d1 -> d2 -> ... -> d9 (9 levels, 50ms each)
  const seqNodes = [{ id: 't', type: 'trigger', config: {} }];
  const seqEdges = [];
  for (let i = 1; i <= 9; i++) {
    seqNodes.push(delayNode(`d${i}`, 0.05));
    seqEdges.push([i === 1 ? 't' : `d${i - 1}`, `d${i}`]);
  }
  runner.register({ id: 'bench-seq', nodes: seqNodes, edges: seqEdges });

  // Parallel fan-out: trigger -> 9 delay nodes in ONE level (50ms each)
  const parNodes = [{ id: 't', type: 'trigger', config: {} }];
  const parEdges = [];
  for (let i = 1; i <= 9; i++) {
    parNodes.push(delayNode(`p${i}`, 0.05));
    parEdges.push(['t', `p${i}`]);
  }
  runner.register({ id: 'bench-par', nodes: parNodes, edges: parEdges });

  const reps = QUICK ? 2 : 5;
  const seqTimes = [];
  const parTimes = [];
  for (let i = 0; i < reps; i++) {
    let t0 = performance.now();
    let run = await runner.startRun('bench-seq', {});
    run = await runner.awaitRun(run.id, 60000);
    if (run.status !== 'succeeded') throw new Error('seq run failed');
    seqTimes.push(performance.now() - t0);

    t0 = performance.now();
    run = await runner.startRun('bench-par', {});
    run = await runner.awaitRun(run.id, 60000);
    if (run.status !== 'succeeded') throw new Error('par run failed');
    parTimes.push(performance.now() - t0);
  }
  const s = pct(seqTimes);
  const p = pct(parTimes);
  report('workflow 9x50ms sequential', `${s.p50.toFixed(0)}`, 'ms p50 (floor ~450ms)');
  report('workflow 9x50ms parallel', `${p.p50.toFixed(0)}`, 'ms p50 (floor ~50ms)');
  report('parallel speedup', `${(s.p50 / Math.max(p.p50, 1)).toFixed(1)}x`, '');
  runner.close();
}

// ---------------------------------------------------------------------------
// 4. SQLite performance (in-process)
// ---------------------------------------------------------------------------
async function benchSqlite() {
  console.log('\n[4] SQLite performance (in-process)');
  const { SessionStore } = await import('../packages/agent-runtime/dist/sessions.js');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sql-')), 'sessions.db');
  const store = new SessionStore(dbPath);

  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    store.appendMessage(`bench-session`, { role: 'user', content: `message ${i}` });
  }
  const writeMs = performance.now() - t0;
  report('1000 session writes', `${writeMs.toFixed(0)}`, `ms (${(1000000 / writeMs).toFixed(0)} writes/s)`);

  const t1 = performance.now();
  const msgs = await store.getMessages('bench-session');
  const readMs = performance.now() - t1;
  report(`read ${msgs.length} msgs`, `${readMs.toFixed(2)}`, 'ms');

  // EXPLAIN QUERY PLAN on hot paths
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const plans = {};
  for (const [name, sql] of [
    ['messages by session', 'EXPLAIN QUERY PLAN SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 100'],
    ['approvals by status', 'EXPLAIN QUERY PLAN SELECT * FROM approvals WHERE status = ? ORDER BY ts DESC'],
  ]) {
    try {
      const rows = db.prepare(sql).all('x');
      plans[name] = rows.map((r) => r.detail).join(' | ');
    } catch (e) {
      plans[name] = `n/a (${e.message})`;
    }
  }
  db.close();
  console.log('  query plans:');
  for (const [k, v] of Object.entries(plans)) console.log(`    ${k}: ${v}`);
  results['query_plans'] = plans;
  store.close();
}

// ---------------------------------------------------------------------------
// 5. Memory footprint
// ---------------------------------------------------------------------------
async function benchMemory(port, child) {
  console.log('\n[5] Memory footprint (server RSS)');
  const rssMB = () => Math.round(child.pid ? rssOf(child.pid) / 1024 / 1024 : 0);
  report('RSS after boot', `${rssMB()}`, 'MB');
  if (QUICK) return;

  // 10 chat turns (exercises runtime + session store + governance audit writes).
  // The DEMO_MOCK scripted turn requests a write_file approval; the reviewer
  // model can't vet it (no free model on the mock provider), so the turn
  // escalates to a human card. The bench plays the human: it polls for
  // pending approvals on the soak session and approves them.
  async function soakTurn(i) {
    void i;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 60000);
    try {
      const done = fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: 'helper', message: `memory soak ${i}`, sessionId: 'bench-mem', provider: 'demo' }),
        signal: ctrl.signal,
      }).then((r) => r.text().catch(() => ''));
      let settled = false;
      void done.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      const t0 = Date.now();
      while (!settled && Date.now() - t0 < 55000) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/api/approvals`)).json();
          for (const a of list) {
            if (a.status === 'pending' && a.sessionId === 'bench-mem') {
              await fetch(`http://127.0.0.1:${port}/api/approvals/${a.id}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ decision: 'approved' }),
              }).catch(() => {});
            }
          }
        } catch {}
        await sleep(500);
      }
      await done;
    } finally {
      clearTimeout(timeout);
    }
  }
  for (let i = 0; i < 10; i++) {
    await soakTurn(i);
  }
  await sleep(1000);
  report('RSS after 10 chat turns', `${rssMB()}`, 'MB');
}

function rssOf(pid) {
  try {
    const out = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = out.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 6. Bundle sizes
// ---------------------------------------------------------------------------
function benchBundles() {
  console.log('\n[6] Bundle sizes');
  const binStat = fs.statSync(path.join(repo, 'dist', 'mvp-server'));
  report('mvp-server binary', (binStat.size / 1024 / 1024).toFixed(1), 'MB');

  const outDir = path.join(repo, 'apps', 'web', 'out');
  if (fs.existsSync(outDir)) {
    let total = 0;
    let jsTotal = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const s = fs.statSync(p).size;
          total += s;
          if (p.endsWith('.js')) jsTotal += s;
        }
      }
    };
    walk(outDir);
    report('web static export', (total / 1024 / 1024).toFixed(1), 'MB total');
    report('web JS', (jsTotal / 1024 / 1024).toFixed(1), 'MB js');
  } else {
    console.log('  web out/ not present — skipping');
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== MVP performance benchmarks ===' + (QUICK ? ' (--quick)' : ''));
  const { child, port, dataDir } = await benchBoot();
  try {
    await benchLatency(port);
    await benchWorkflows();
    await benchSqlite();
    await benchMemory(port, child);
    benchBundles();
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('\n=== done ===');
  const outPath = path.join(repo, 'docs', 'bench-results.json');
  fs.writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), quick: QUICK, results }, null, 2));
  console.log(`results written to docs/bench-results.json`);
}

main().catch((err) => {
  console.error('BENCH FAILED:', err);
  process.exit(1);
});
