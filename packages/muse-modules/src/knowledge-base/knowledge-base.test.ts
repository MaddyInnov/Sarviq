// SPDX-License-Identifier: Apache-2.0
// Tests for the RAG knowledge base. Fully offline — MockEmbedder only.

import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleDb } from '../db.js';
import {
  MockEmbedder,
  LocalEmbedder,
  cosineSimilarity,
  chunkText,
  extractTextFromPdf,
  extractTextFromHtml,
  formatCitedSources,
  appendSourcesSection,
  KnowledgeBaseStore,
  type KbRetrievedChunk,
} from './index.js';

let mdb: ModuleDb;
let kb: KnowledgeBaseStore;

beforeEach(() => {
  mdb = new ModuleDb(':memory:');
  kb = new KnowledgeBaseStore(mdb, new MockEmbedder());
});

// ---------------------------------------------------------------- chunking

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });

  it('returns [] for empty text', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long text into overlapping chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, { chunkTokens: 10, overlapTokens: 2 }); // ~40 chars, ~8 overlap
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: consecutive chunks share at least one full word.
    const words0 = new Set(chunks[0].split(' '));
    const words1 = chunks[1].split(' ');
    expect(words1.some((w) => words0.has(w))).toBe(true);
    // No chunk is empty.
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    // Full coverage: every word appears in at least one chunk.
    const joined = chunks.join(' ');
    for (let i = 0; i < 200; i++) expect(joined).toContain(`word${i}`);
  });

  it('does not split mid-word when possible', () => {
    const text = 'a '.repeat(500) + 'superlongwordthatshouldnotbesplitinthemiddle';
    const chunks = chunkText(text, { chunkTokens: 50, overlapTokens: 5 });
    // The long word appears whole in some chunk.
    expect(chunks.some((c) => c.includes('superlongwordthatshouldnotbesplitinthemiddle'))).toBe(true);
  });
});

// ---------------------------------------------------------------- embedders

describe('MockEmbedder', () => {
  it('is deterministic', async () => {
    const e = new MockEmbedder();
    const [a] = await e.embed(['the quick brown fox']);
    const [b] = await e.embed(['the quick brown fox']);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces unit vectors of the right dim', async () => {
    const e = new MockEmbedder();
    const [v] = await e.embed(['hello']);
    expect(v.length).toBe(e.dim);
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('ranks identical text highest', async () => {
    const e = new MockEmbedder();
    const [q, same, diff] = await e.embed(['apple banana', 'apple banana', 'quantum zebra xylophone']);
    expect(cosineSimilarity(q, same)).toBeGreaterThan(cosineSimilarity(q, diff));
  });
});

describe('LocalEmbedder', () => {
  it('is deterministic and normalized', async () => {
    const e = new LocalEmbedder();
    const [a] = await e.embed(['local embeddings without network']);
    const [b] = await e.embed(['local embeddings without network']);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(384);
    const norm = Math.sqrt(Array.from(a).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('similar texts score higher than dissimilar ones', async () => {
    const e = new LocalEmbedder();
    const [q, close, far] = await e.embed([
      'the cat sat on the mat',
      'the cat sat on the rug',
      'quantum field theory renormalization group',
    ]);
    expect(cosineSimilarity(q, close)).toBeGreaterThan(cosineSimilarity(q, far));
  });
});

// ---------------------------------------------------------------- extraction

describe('extractTextFromPdf', () => {
  it('extracts Tj text from BT/ET blocks', () => {
    const pdf = Buffer.from(
      '1 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 712 Td (Hello PDF World) Tj ET\nendstream\nendobj',
      'latin1',
    );
    expect(extractTextFromPdf(pdf)).toContain('Hello PDF World');
  });

  it('extracts TJ array text', () => {
    const pdf = Buffer.from(
      'stream\nBT [(First) 20 (Second)] TJ ET\nendstream',
      'latin1',
    );
    const text = extractTextFromPdf(pdf);
    expect(text).toContain('First');
    expect(text).toContain('Second');
  });

  it('returns empty string for PDFs with no text blocks', () => {
    expect(extractTextFromPdf(Buffer.from('not a pdf at all'))).toBe('');
  });
});

describe('extractTextFromHtml', () => {
  it('strips tags and scripts', () => {
    const html = '<html><head><script>var x=1;</script></head><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>';
    const text = extractTextFromHtml(html);
    expect(text).toContain('Title');
    expect(text).toContain('Hello world');
    expect(text).not.toContain('var x=1');
    expect(text).not.toContain('<h1>');
  });
});

// ---------------------------------------------------------------- store

describe('KnowledgeBaseStore documents', () => {
  it('adds a document and chunks it', async () => {
    const doc = await kb.addDocument({
      title: 'Test Doc',
      fileName: 'test.md',
      mimeType: 'text/markdown',
      text: 'alpha beta gamma. '.repeat(500),
    });
    expect(doc.title).toBe('Test Doc');
    expect(doc.chunkCount).toBeGreaterThan(1);
    expect(doc.charCount).toBeGreaterThan(0);
    const listed = kb.listDocuments();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(doc.id);
  });

  it('rejects empty text', async () => {
    await expect(
      kb.addDocument({ title: 'Empty', fileName: 'e.txt', mimeType: 'text/plain', text: '   ' }),
    ).rejects.toThrow();
  });

  it('deletes a document and cascades chunks', async () => {
    const doc = await kb.addDocument({
      title: 'Gone',
      fileName: 'g.txt',
      mimeType: 'text/plain',
      text: 'some content here that will be deleted',
    });
    // Query works before delete.
    expect(await kb.query({ query: 'deleted content' })).toHaveLength(1);
    kb.deleteDocument(doc.id);
    expect(kb.listDocuments()).toHaveLength(0);
    expect(await kb.query({ query: 'deleted content' })).toHaveLength(0);
    expect(() => kb.getDocument(doc.id)).toThrow();
  });

  it('assigns documents to corpora and filters queries', async () => {
    const c1 = kb.createCorpus('alpha');
    const c2 = kb.createCorpus('beta');
    await kb.addDocument({ title: 'A', fileName: 'a.txt', mimeType: 'text/plain', text: 'cats are great pets', corpusId: c1.id });
    await kb.addDocument({ title: 'B', fileName: 'b.txt', mimeType: 'text/plain', text: 'dogs are great pets', corpusId: c2.id });

    const onlyA = await kb.query({ query: 'great pets', corpusIds: [c1.id] });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].documentTitle).toBe('A');

    const all = await kb.query({ query: 'great pets' });
    expect(all).toHaveLength(2);
  });

  it('deleting a corpus unlinks (not deletes) documents', async () => {
    const c = kb.createCorpus('temp');
    const doc = await kb.addDocument({ title: 'D', fileName: 'd.txt', mimeType: 'text/plain', text: 'keep me', corpusId: c.id });
    kb.deleteCorpus(c.id);
    expect(kb.listCorpora()).toHaveLength(0);
    expect(kb.getDocument(doc.id).corpusId).toBeNull();
  });
});

describe('KnowledgeBaseStore query ranking', () => {
  it('ranks the most relevant chunk first', async () => {
    await kb.addDocument({
      title: 'Cats',
      fileName: 'cats.txt',
      mimeType: 'text/plain',
      text: 'cats cats cats felines purring whiskers',
    });
    await kb.addDocument({
      title: 'Dogs',
      fileName: 'dogs.txt',
      mimeType: 'text/plain',
      text: 'dogs dogs dogs canines barking tails',
    });
    const res = await kb.query({ query: 'tell me about cats felines', topK: 2 });
    expect(res).toHaveLength(2);
    expect(res[0].documentTitle).toBe('Cats');
    expect(res[0].score).toBeGreaterThanOrEqual(res[1].score);
  });

  it('respects topK bounds', async () => {
    await kb.addDocument({ title: 'X', fileName: 'x.txt', mimeType: 'text/plain', text: 'x '.repeat(3000) });
    const res = await kb.query({ query: 'x', topK: 1 });
    expect(res).toHaveLength(1);
  });

  it('returns [] on empty knowledge base', async () => {
    expect(await kb.query({ query: 'anything' })).toEqual([]);
  });
});

// ---------------------------------------------------------------- citations

function fakeChunk(title: string, text: string): KbRetrievedChunk {
  return { chunkId: 'c', documentId: 'd', documentTitle: title, corpusId: null, idx: 0, text, page: null, score: 0.9 };
}

describe('citations', () => {
  it('formats [1], [2] cited sources', () => {
    const s = formatCitedSources([fakeChunk('Doc A', 'alpha text'), fakeChunk('Doc B', 'beta text')]);
    expect(s).toContain('[1]');
    expect(s).toContain('[2]');
    expect(s).toContain('Doc A');
    expect(s).toContain('Doc B');
  });

  it('appends a Sources section', () => {
    const out = appendSourcesSection('The answer is 42.', [fakeChunk('Doc A', 'x'), fakeChunk('Doc B', 'y')]);
    expect(out).toContain('The answer is 42.');
    expect(out).toContain('**Sources**');
    expect(out).toContain('1. Doc A');
    expect(out).toContain('2. Doc B');
  });

  it('leaves answers without sources untouched', () => {
    expect(appendSourcesSection('plain', [])).toBe('plain');
  });
});
