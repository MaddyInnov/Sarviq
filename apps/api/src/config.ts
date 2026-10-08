// SPDX-License-Identifier: Apache-2.0
// Runtime configuration: env vars with sane defaults. Everything the server
// needs to boot is derived here so routes stay free of process.env reads.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  dataDir: string;
  seedDir: string;
  skillsDir: string;
  workspaceDir: string;
  webOutDir: string;
}

function resolveDir(envValue: string | undefined, fallback: string): string {
  return envValue ? path.resolve(envValue) : fallback;
}

/**
 * Port resolution order: `--port <n>` CLI arg (the Tauri sidecar spawns the
 * API with `--port 4567`) → PORT env → 4000.
 */
export function parsePort(argv: string[]): number {
  const flagIndex = argv.findIndex((a) => a === '--port');
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const raw = fromFlag ?? process.env.PORT ?? '4000';
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.warn(`[config] invalid port "${raw}" — falling back to 4000`);
    return 4000;
  }
  return port;
}

export function loadConfig(): AppConfig {
  const port = parsePort(process.argv);
  // DATA_DIR defaults to ./data relative to the current working directory
  // (apps/api when started via `bun src/index.ts` from that directory).
  // The Tauri desktop shell passes its app-data dir via DATA_DIR.
  const dataDir = resolveDir(process.env.DATA_DIR, path.resolve(process.cwd(), 'data'));
  // SEED_DIR defaults to ../../seed relative to apps/api (i.e. mvp/seed).
  // import.meta.url points at src/ in dev or dist/ after tsc — both are one
  // level below apps/api, so ../../seed resolves to mvp/seed either way.
  const seedDir = resolveDir(process.env.SEED_DIR, path.resolve(SRC_DIR, '../../seed'));
  return {
    port: Number.isFinite(port) ? port : 4000,
    dataDir,
    seedDir,
    skillsDir: path.join(seedDir, 'skills'),
    workspaceDir: path.join(dataDir, 'workspace'),
    // ../web/out relative to apps/api (src/ and dist/ are both one level deep).
    webOutDir: path.resolve(SRC_DIR, '../../web/out'),
  };
}
