// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import { SlideDeckStore, exportDeckMarkdown, exportDeckHtml, SLIDE_LAYOUTS } from './index.js';
import { ValidationError, NotFoundError } from '../errors.js';

describe('SlideDeckStore', () => {
  let mdb: ModuleDb;
  let store: SlideDeckStore;
  beforeEach(() => {
    mdb = new ModuleDb(':memory:');
    store = new SlideDeckStore(mdb);
  });

  it('creates, gets, lists, updates, deletes decks', () => {
    const deck = store.create({
      title: 'Q3 Review',
      slides: [
        { layout: 'title', heading: 'Q3 Review', bullets: ['All-hands'] },
        { layout: 'bullets', heading: 'Wins', bullets: ['Revenue up', 'Churn down'], notes: 'Emphasize churn' },
      ],
    });
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].layout).toBe('title');
    expect(store.list()).toHaveLength(1);

    const updated = store.update(deck.id, { title: 'Q3 Review (final)' });
    expect(updated.title).toBe('Q3 Review (final)');
    expect(updated.slides).toHaveLength(2);

    store.delete(deck.id);
    expect(store.list()).toHaveLength(0);
    expect(() => store.get(deck.id)).toThrow(NotFoundError);
  });

  it('validates title and layout', () => {
    expect(() => store.create({ title: '' })).toThrow(ValidationError);
    expect(() =>
      store.create({ title: 'x', slides: [{ layout: 'fancy' as never, heading: 'h' }] }),
    ).toThrow(ValidationError);
  });

  it('supports all layouts', () => {
    const deck = store.create({
      title: 'Layouts',
      slides: SLIDE_LAYOUTS.map((layout) => ({ layout, heading: layout })),
    });
    expect(deck.slides.map((s) => s.layout)).toEqual(SLIDE_LAYOUTS);
  });

  it('assigns ids to slides missing them', () => {
    const deck = store.create({ title: 't', slides: [{ heading: 'h' }] });
    expect(deck.slides[0].id).toBeTruthy();
  });
});

describe('exportDeckMarkdown', () => {
  it('renders slides as markdown sections', () => {
    const store = new SlideDeckStore(new ModuleDb(':memory:'));
    const deck = store.create({
      title: 'Demo',
      slides: [
        { layout: 'bullets', heading: 'Agenda', bullets: ['Intro', 'Demo'], notes: 'Keep it short' },
        { layout: 'two-column', heading: 'Compare', bullets: ['A'], extra: ['B'] },
      ],
    });
    const md = exportDeckMarkdown(deck);
    expect(md).toContain('# Demo');
    expect(md).toContain('## Agenda');
    expect(md).toContain('- Intro');
    expect(md).toContain('**Left**');
    expect(md).toContain('**Right**');
    expect(md).toContain('> Notes: Keep it short');
  });
});

describe('exportDeckHtml', () => {
  it('produces a self-contained navigable deck', () => {
    const store = new SlideDeckStore(new ModuleDb(':memory:'));
    const deck = store.create({
      title: 'Demo <deck>',
      slides: [
        { layout: 'title', heading: 'Welcome', bullets: ['Subtitle here'] },
        { layout: 'bullets', heading: 'Points', bullets: ['One', 'Two'] },
        { layout: 'image', heading: 'Photo', bullets: ['Caption'], extra: ['https://example.com/p.png'] },
      ],
    });
    const html = exportDeckHtml(deck);
    // Escaped title.
    expect(html).toContain('Demo &lt;deck&gt;');
    // All three slides present, first active.
    expect(html.match(/<section class="slide/g)).toHaveLength(3);
    expect(html).toContain('class="slide active"');
    // Keyboard nav script present.
    expect(html).toContain('ArrowRight');
    // Image layout renders img.
    expect(html).toContain('<img src="https://example.com/p.png"');
    // No external assets.
    expect(html).not.toContain('http://');
    expect(html).not.toContain('<link');
  });
});
