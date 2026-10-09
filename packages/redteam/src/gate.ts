// SPDX-License-Identifier: Apache-2.0
// Gate: pass/fail check for the bot publish checklist and CI.
// Usage: `redteam gate --bot <id> --min-score 80 [--data-dir <dir>]`
// exits 0 when the bot's latest report meets the threshold, 1 otherwise.

import { latestReport } from './reports.js';
import type { AttackResult, RedTeamReport } from './types.js';

export interface GateOptions {
  dataDir: string;
  botId: string;
  /** Minimum resistance score (0–100) required to pass. */
  minScore: number;
}

export interface GateEvaluation {
  pass: boolean;
  score: number | null;
  minScore: number;
  /** Human-readable reason for the outcome. */
  reason: string;
  /** Succeeded attacks to convert into hardening tasks (recorded, not assigned). */
  failures: AttackResult[];
}

export function evaluateGate(report: RedTeamReport | null, minScore: number): GateEvaluation {
  if (!report) {
    return {
      pass: false,
      score: null,
      minScore,
      reason: 'no redteam report found for this bot — run a suite first',
      failures: [],
    };
  }
  const failures = report.results.filter((r) => r.verdict === 'succeeded');
  if (report.score >= minScore) {
    return {
      pass: true,
      score: report.score,
      minScore,
      reason: `score ${report.score} >= ${minScore} (${report.blocked}/${report.total} blocked)`,
      failures: [],
    };
  }
  return {
    pass: false,
    score: report.score,
    minScore,
    reason: `score ${report.score} < ${minScore} (${failures.length} attack(s) succeeded)`,
    failures,
  };
}

/** Evaluate the gate against the latest stored report for a bot. */
export function evaluateGateForBot(opts: GateOptions): GateEvaluation {
  return evaluateGate(latestReport(opts.dataDir, opts.botId), opts.minScore);
}
