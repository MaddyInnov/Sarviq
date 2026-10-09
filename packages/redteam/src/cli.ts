#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `redteam` CLI: list suites, run a suite against a mock bot (CI self-check),
// and gate on the latest stored report.
//
//   redteam list-suites
//   redteam run --bot <id> --suite <name> --mock <hardened|naive> --data-dir <dir>
//   redteam gate --bot <id> --min-score 80 --data-dir <dir>   (exit 1 on fail)
//
// Production runs against real bots go through the API
// (POST /api/bots/:id/redteam/run), which drives AgentRuntime.

import { evaluateGateForBot } from './gate.js';
import { runSuite } from './harness.js';
import { HardenedMockRunner, NaiveMockRunner } from './mock-bots.js';
import { listSuites } from './attacks.js';
import { saveReport } from './reports.js';

function usage(): string {
  return [
    'Usage:',
    '  redteam list-suites',
    '  redteam run --bot <id> --suite <name> --mock <hardened|naive> --data-dir <dir>',
    '  redteam gate --bot <id> --min-score <n> --data-dir <dir>',
  ].join('\n');
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'list-suites') {
    for (const s of listSuites()) console.log(s);
    return;
  }
  if (cmd === 'run') {
    const botId = flag(args, '--bot');
    const suite = flag(args, '--suite') ?? 'core';
    const mock = flag(args, '--mock') ?? 'hardened';
    const dataDir = flag(args, '--data-dir') ?? './data';
    if (!botId) {
      console.error('missing --bot <id>');
      process.exit(2);
    }
    const runner = mock === 'naive' ? new NaiveMockRunner() : new HardenedMockRunner();
    const report = await runSuite(runner, { id: botId, name: botId, systemPrompt: '' }, suite);
    saveReport(dataDir, report);
    console.log(`score ${report.score} (${report.blocked}/${report.total} blocked) — saved for bot ${botId}`);
    for (const r of report.results) {
      console.log(`  [${r.verdict === 'blocked' ? 'PASS' : 'FAIL'}] ${r.attackId} ${r.name}`);
    }
    return;
  }
  if (cmd === 'gate') {
    const botId = flag(args, '--bot');
    const minScore = Number(flag(args, '--min-score') ?? '80');
    const dataDir = flag(args, '--data-dir') ?? './data';
    if (!botId || !Number.isFinite(minScore)) {
      console.error('missing --bot <id> or invalid --min-score');
      process.exit(2);
    }
    const evaled = evaluateGateForBot({ dataDir, botId, minScore });
    console.log(evaled.pass ? 'GATE PASS' : 'GATE FAIL', '—', evaled.reason);
    for (const f of evaled.failures) {
      console.log(`  hardening: [${f.attackId}] ${f.name} — ${f.hardeningNote}`);
    }
    process.exit(evaled.pass ? 0 : 1);
  }
  console.error(usage());
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
