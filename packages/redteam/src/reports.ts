// SPDX-License-Identifier: Apache-2.0
// Report persistence: <dataDir>/redteam-reports/<botId>.json
// (a JSON array of reports, newest last, capped at MAX_HISTORY entries).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RedTeamReport } from './types.js';

export const REPORTS_DIR = 'redteam-reports';
const MAX_HISTORY = 25;

function reportsPath(dataDir: string, botId: string): string {
  const safe = botId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dataDir, REPORTS_DIR, `${safe}.json`);
}

/** Append a report to the bot's history (creates the dir/file as needed). */
export function saveReport(dataDir: string, report: RedTeamReport): RedTeamReport {
  const dir = join(dataDir, REPORTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = reportsPath(dataDir, report.botId);
  const history = listReports(dataDir, report.botId);
  history.push(report);
  const trimmed = history.slice(-MAX_HISTORY);
  writeFileSync(path, JSON.stringify(trimmed, null, 2), 'utf8');
  return report;
}

/** All stored reports for a bot, oldest first. Empty array when none. */
export function listReports(dataDir: string, botId: string): RedTeamReport[] {
  const path = reportsPath(dataDir, botId);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as RedTeamReport[]) : [];
  } catch {
    return [];
  }
}

/** The most recent stored report for a bot, or null. */
export function latestReport(dataDir: string, botId: string): RedTeamReport | null {
  const history = listReports(dataDir, botId);
  return history.length > 0 ? history[history.length - 1] : null;
}
