// SPDX-License-Identifier: Apache-2.0
// Static frontend serving for single-binary distribution.
// API routes are mounted FIRST (in index.ts); this module only handles
// non-/api paths.
//
// Two sources, tried in order:
//  1. Embedded assets: `src/generated/web-assets.ts` exporting WEB_ASSETS
//     (Record<path, { contentType, gzipBase64 }>), produced by
//     scripts/embed-web.mjs before every build/dev run (empty map when
//     apps/web/out is absent).
//  2. Fallback: express.static over the Next.js static export at ../web/out.
//
// Unknown non-/api paths fall back to /index.html (SPA fallback).

import express from 'express';
import path from 'node:path';

// scripts/embed-web.mjs generates src/generated/web-assets.ts before every
// build/dev run (empty map when apps/web/out is absent). Static import so
// Bun's `--compile` bundles the assets into single binaries.
import { WEB_ASSETS } from './generated/web-assets.js';

interface EmbeddedAsset {
  contentType: string;
  gzipBase64: string;
}

type EmbeddedMap = Record<string, EmbeddedAsset>;

function loadEmbedded(): EmbeddedMap | null {
  if (WEB_ASSETS && typeof WEB_ASSETS === 'object' && Object.keys(WEB_ASSETS).length > 0) {
    return WEB_ASSETS;
  }
  return null;
}

function normalizeAssetPath(requestPath: string): string {
  let p = requestPath;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p === '/') return '/index.html';
  return p;
}

/**
 * Candidate asset keys for a request path, in order. The Next.js static
 * export writes `<page>.html` files (trailingSlash: false), so `/approvals`
 * must resolve to `/approvals.html`. Unknown paths fall back to /index.html
 * (SPA fallback) — note this means deep links to dynamic routes like
 * /workflows/<runId> (which have no static HTML) render the home page;
 * in-app client-side navigation is the supported path there.
 */
function assetCandidates(requestPath: string): string[] {
  const key = normalizeAssetPath(requestPath);
  const candidates = [key];
  if (!key.endsWith('.html')) {
    candidates.push(`${key}.html`);
    candidates.push(`${key.replace(/\/$/, '')}/index.html`);
  }
  candidates.push('/index.html');
  return candidates;
}

function findEmbedded(embedded: EmbeddedMap, requestPath: string): EmbeddedAsset | null {
  for (const key of assetCandidates(requestPath)) {
    const asset = embedded[key];
    if (asset) return asset;
  }
  return null;
}

export function mountWebAssets(app: express.Express, webOutDir: string): void {
  const embedded = loadEmbedded();

  if (embedded) {
    console.log(`[web] serving ${Object.keys(embedded).length} embedded frontend asset(s)`);
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/api') return next();
      const asset = findEmbedded(embedded, req.path);
      if (!asset) {
        res.status(404).send('Not found');
        return;
      }
      const body = Buffer.from(asset.gzipBase64, 'base64');
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(body.length));
      res.send(body);
    });
    return;
  }

  console.log(`[web] serving static export from ${webOutDir}`);
  // `extensions: ['html']` lets /approvals resolve to /approvals.html
  // (Next.js static export with trailingSlash: false).
  app.use(express.static(webOutDir, { extensions: ['html'], index: 'index.html' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') return next();
    res.sendFile(path.join(webOutDir, 'index.html'), (err) => {
      if (err && !res.headersSent) res.status(404).send('Not found');
    });
  });
}
