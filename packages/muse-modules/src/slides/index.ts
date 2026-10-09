// SPDX-License-Identifier: Apache-2.0
// Slide deck builder (Space/OpenDots parity).
//
// - SlideDeck: titled deck with an ordered list of slides (layouts:
//   title, bullets, two-column, image).
// - CRUD store backed by the shared ModuleDb.
// - Export to self-contained HTML (keyboard-navigable deck) and Markdown.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

export type SlideLayout = 'title' | 'bullets' | 'two-column' | 'image';

export const SLIDE_LAYOUTS: SlideLayout[] = ['title', 'bullets', 'two-column', 'image'];

export interface Slide {
  id: string;
  layout: SlideLayout;
  heading: string;
  bullets: string[];
  /** Right-column bullets (two-column) or image URL (image layout). */
  extra: string[];
  /** Speaker notes (not shown on the slide). */
  notes: string;
}

export interface SlideDeck {
  id: string;
  title: string;
  slides: Slide[];
  createdAt: number;
  updatedAt: number;
}

interface DeckRow {
  id: string;
  title: string;
  slides_json: string;
  created_at: number;
  updated_at: number;
}

function rowToDeck(r: DeckRow): SlideDeck {
  return {
    id: r.id,
    title: r.title,
    slides: JSON.parse(r.slides_json) as Slide[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function validateSlideInput(s: Partial<Slide>, i: number): Slide {
  const layout = s.layout ?? 'bullets';
  if (!SLIDE_LAYOUTS.includes(layout as SlideLayout)) {
    throw new ValidationError(`slide ${i}: layout must be one of ${SLIDE_LAYOUTS.join(', ')}`);
  }
  return {
    id: typeof s.id === 'string' && s.id ? s.id : randomUUID(),
    layout: layout as SlideLayout,
    heading: String(s.heading ?? '').slice(0, 200),
    bullets: Array.isArray(s.bullets) ? s.bullets.map((b) => String(b).slice(0, 500)).slice(0, 20) : [],
    extra: Array.isArray(s.extra) ? s.extra.map((b) => String(b).slice(0, 500)).slice(0, 20) : [],
    notes: String(s.notes ?? '').slice(0, 2000),
  };
}

export class SlideDeckStore {
  constructor(private readonly mdb: ModuleDb) {}

  create(input: { title: string; slides?: Partial<Slide>[] }): SlideDeck {
    const title = (input.title ?? '').trim();
    if (!title) throw new ValidationError('deck "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('deck "title" must be at most 200 characters');
    const slides = (input.slides ?? []).map((s, i) => validateSlideInput(s, i));
    if (slides.length > 100) throw new ValidationError('deck cannot have more than 100 slides');
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare('INSERT INTO mm_slide_decks (id, title, slides_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, JSON.stringify(slides), now, now);
    return this.get(id);
  }

  get(id: string): SlideDeck {
    const row = this.mdb.db
      .prepare('SELECT id, title, slides_json, created_at, updated_at FROM mm_slide_decks WHERE id = ?')
      .get(id) as DeckRow | undefined;
    if (!row) throw new NotFoundError(`unknown slide deck: ${id}`);
    return rowToDeck(row);
  }

  list(): SlideDeck[] {
    const rows = this.mdb.db
      .prepare('SELECT id, title, slides_json, created_at, updated_at FROM mm_slide_decks ORDER BY updated_at DESC')
      .all() as unknown as DeckRow[];
    return rows.map(rowToDeck);
  }

  update(id: string, input: { title?: string; slides?: Partial<Slide>[] }): SlideDeck {
    const existing = this.get(id);
    const title = input.title !== undefined ? input.title.trim() : existing.title;
    if (!title) throw new ValidationError('deck "title" must be a non-empty string');
    if (title.length > 200) throw new ValidationError('deck "title" must be at most 200 characters');
    const slides = input.slides !== undefined ? input.slides.map((s, i) => validateSlideInput(s, i)) : existing.slides;
    if (slides.length > 100) throw new ValidationError('deck cannot have more than 100 slides');
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_slide_decks SET title = ?, slides_json = ?, updated_at = ? WHERE id = ?')
      .run(title, JSON.stringify(slides), now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id); // throws NotFoundError if missing
    this.mdb.db.prepare('DELETE FROM mm_slide_decks WHERE id = ?').run(id);
  }
}

/** Escape HTML special chars. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Export a deck to Markdown (one section per slide). */
export function exportDeckMarkdown(deck: SlideDeck): string {
  const lines: string[] = [`# ${deck.title}`, ''];
  for (const slide of deck.slides) {
    lines.push(`## ${slide.heading || '(untitled)'}`);
    lines.push('');
    if (slide.layout === 'two-column') {
      lines.push('**Left**');
      for (const b of slide.bullets) lines.push(`- ${b}`);
      lines.push('');
      lines.push('**Right**');
      for (const b of slide.extra) lines.push(`- ${b}`);
    } else if (slide.layout === 'image') {
      for (const b of slide.bullets) lines.push(`- ${b}`);
      for (const u of slide.extra) lines.push(`![](${u})`);
    } else {
      for (const b of slide.bullets) lines.push(`- ${b}`);
    }
    if (slide.notes) {
      lines.push('');
      lines.push(`> Notes: ${slide.notes}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Export a deck to a self-contained HTML file: one full-viewport slide at a
 * time, arrow-key / click navigation, slide counter, print-friendly.
 * No external assets — works offline.
 */
export function exportDeckHtml(deck: SlideDeck): string {
  const slideHtml = deck.slides
    .map((s, i) => {
      let body = '';
      if (s.layout === 'title') {
        body = `<div class="slide-title"><h1>${esc(s.heading)}</h1>${s.bullets.map((b) => `<p class="subtitle">${esc(b)}</p>`).join('')}</div>`;
      } else if (s.layout === 'two-column') {
        body =
          `<h2>${esc(s.heading)}</h2><div class="cols">` +
          `<div class="col"><ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>` +
          `<div class="col"><ul>${s.extra.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div></div>`;
      } else if (s.layout === 'image') {
        body =
          `<h2>${esc(s.heading)}</h2>` +
          (s.extra[0] ? `<img src="${esc(s.extra[0])}" alt=""/>` : '') +
          `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
      } else {
        body = `<h2>${esc(s.heading)}</h2><ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
      }
      return `<section class="slide${i === 0 ? ' active' : ''}" data-i="${i}">${body}</section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(deck.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #eee; overflow: hidden; }
  .deck { position: relative; width: 100vw; height: 100vh; }
  .slide { display: none; position: absolute; inset: 0; padding: 8vh 10vw; flex-direction: column; justify-content: center; }
  .slide.active { display: flex; }
  .slide h1 { font-size: 4rem; margin-bottom: 1rem; }
  .slide h2 { font-size: 2.5rem; margin-bottom: 2rem; color: #a8d8ff; }
  .slide ul { font-size: 1.5rem; line-height: 2.2; padding-left: 1.5em; }
  .slide .subtitle { font-size: 1.8rem; color: #aaa; }
  .slide-title { text-align: center; }
  .cols { display: flex; gap: 4rem; }
  .col { flex: 1; }
  .slide img { max-width: 60%; max-height: 50vh; border-radius: 12px; margin-bottom: 1.5rem; }
  .counter { position: fixed; bottom: 1.5rem; right: 2rem; color: #888; font-size: 1rem; }
  .hint { position: fixed; bottom: 1.5rem; left: 2rem; color: #666; font-size: 0.9rem; }
  @media print { .slide { display: flex; position: static; height: auto; page-break-after: always; } .hint { display: none; } }
</style>
</head>
<body>
<div class="deck">
${slideHtml}
</div>
<div class="counter"><span id="n">1</span> / ${deck.slides.length}</div>
<div class="hint">← → or click to navigate</div>
<script>
  let i = 0;
  const slides = document.querySelectorAll('.slide');
  const n = document.getElementById('n');
  function show(k) {
    i = Math.max(0, Math.min(slides.length - 1, k));
    slides.forEach((s, j) => s.classList.toggle('active', j === i));
    n.textContent = i + 1;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') show(i + 1);
    if (e.key === 'ArrowLeft') show(i - 1);
    if (e.key === 'Home') show(0);
    if (e.key === 'End') show(slides.length - 1);
  });
  document.addEventListener('click', () => show(i + 1));
</script>
</body>
</html>`;
}
