// SPDX-License-Identifier: Apache-2.0
// RAG knowledge base (Octop parity): local-first document ingestion,
// chunking, embeddings, and cited retrieval. Zero API keys required.
//
// Design:
// - `Embedder` interface: `embed(texts) -> Float32Array[]`.
//   - `MockEmbedder`: tiny deterministic hash vectors (tests only).
//   - `LocalEmbedder`: char-trigram hashing into 384 dims, TF-weighted,
//     L2-normalized. Zero dependencies, zero network, deterministic.
//     Honest note: hashing embeddings are weaker than transformer
//     embeddings (e.g. all-MiniLM-L6-v2 via onnxruntime-node). The
//     interface is the swap point — a future OnnxEmbedder can replace
//     LocalEmbedder without touching the store or routes. onnxruntime-node
//     was deliberately NOT taken: native module, ~100MB+ with the model,
//     and it does not survive the bun single-binary compile used for
//     dist/mvp-server.
// - Vectors stored as JSON blobs in `mm_kb_chunks`; brute-force cosine
//   similarity (fine for MVP scale, <10k chunks).
// - Uploaded document bytes are never persisted — text is extracted at
//   ingest time and the buffer is dropped (privacy, like meetings).

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KbCorpus {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface KbDocument {
  id: string;
  corpusId: string | null;
  title: string;
  fileName: string;
  mimeType: string;
  charCount: number;
  chunkCount: number;
  createdAt: number;
}

export interface KbChunk {
  id: string;
  documentId: string;
  idx: number;
  text: string;
  page: number | null;
}

export interface KbRetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  corpusId: string | null;
  idx: number;
  text: string;
  page: number | null;
  score: number;
}

export interface KbQueryOptions {
  query: string;
  topK?: number;
  corpusIds?: string[];
}

// ---------------------------------------------------------------------------
// Embedders
// ---------------------------------------------------------------------------

/** Embedding backend. `embed` must be deterministic for a given input. */
export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]> | Float32Array[];
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministic hash embedder for tests. dim=16, FNV-1a over word
 * unigrams hashed into buckets, L2-normalized. NOT for production
 * ranking quality — use LocalEmbedder.
 */
export class MockEmbedder implements Embedder {
  readonly name = 'mock';
  readonly dim = 16;

  embed(texts: string[]): Float32Array[] {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      for (const w of tokenizeWords(t)) {
        v[fnv1a(w) % this.dim] += 1;
      }
      return l2Normalize(v);
    });
  }
}

/**
 * Zero-dependency local embedder (production default). Char-trigram
 * hashing into 384 dims with TF weighting, L2-normalized. Deterministic,
 * offline, no keys, no downloads. Quality is below transformer
 * embeddings but solid for small-corpus retrieval; the `Embedder`
 * interface is the documented swap point for an ONNX model later.
 */
export class LocalEmbedder implements Embedder {
  readonly name = 'local-trigram';
  readonly dim = 384;

  embed(texts: string[]): Float32Array[] {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      const s = `  ${t.toLowerCase()}  `;
      for (let i = 0; i + 3 <= s.length; i++) {
        const tri = s.slice(i, i + 3);
        v[fnv1a(tri) % this.dim] += 1;
      }
      return l2Normalize(v);
    });
  }
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Target chunk size in ~tokens (4 chars ≈ 1 token). Default 512. */
  chunkTokens?: number;
  /** Overlap in ~tokens. Default 50. */
  overlapTokens?: number;
}

/**
 * Split text into word-boundary chunks of ~chunkTokens with overlap.
 * Returns chunk strings (page tracking is the caller's job).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkChars = (opts.chunkTokens ?? 512) * 4;
  const overlapChars = (opts.overlapTokens ?? 50) * 4;
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkChars, clean.length);
    // Back up to a word boundary (don't split mid-word).
    if (end < clean.length) {
      const ws = clean.lastIndexOf(' ', end);
      if (ws > start + chunkChars * 0.5) end = ws;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Text extraction (zero-dep, best-effort)
// ---------------------------------------------------------------------------

/**
 * Best-effort text extraction from a PDF buffer. Parses BT/ET text blocks
 * and Tj/TJ operators — handles text-based PDFs. Scanned/image PDFs need
 * OCR (documented founder input). Zero dependencies by design.
 */
export function extractTextFromPdf(buf: Uint8Array): string {
  const raw = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  // Match BT ... ET blocks.
  const blockRe = /BT([\s\S]*?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(raw)) !== null) {
    const block = m[1];
    // (text) Tj  and  [(a) 12 (b)] TJ
    const tjRe = /\((?:\\.|[^\\()])*\)\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
    let t: RegExpExecArray | null;
    while ((t = tjRe.exec(block)) !== null) {
      if (t[0].endsWith('Tj')) {
        out.push(unescapePdfString(t[0].slice(0, t[0].lastIndexOf('Tj')).trim()));
      } else {
        const inner = t[1];
        const strRe = /\((?:\\.|[^\\()])*\)/g;
        let s: RegExpExecArray | null;
        while ((s = strRe.exec(inner)) !== null) out.push(unescapePdfString(s[0]));
      }
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function unescapePdfString(s: string): string {
  // s includes surrounding parens.
  const inner = s.slice(1, -1);
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')');
}

/** Strip HTML tags → text. */
export function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Route extraction by mime type / extension. */
export function extractText(fileName: string, mimeType: string, buf: Uint8Array): string {
  const lower = fileName.toLowerCase();
  const mt = mimeType.toLowerCase();
  if (mt.includes('pdf') || lower.endsWith('.pdf')) return extractTextFromPdf(buf);
  if (mt.includes('html') || lower.endsWith('.html') || lower.endsWith('.htm'))
    return extractTextFromHtml(Buffer.from(buf).toString('utf8'));
  // md / txt / anything else: treat as UTF-8 text.
  return Buffer.from(buf).toString('utf8');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_DOCS = 500;
const MAX_CHUNKS_PER_DOC = 2000;

interface CorpusRow {
  id: string;
  name: string;
  description: string;
  created_at: number;
}
interface DocumentRow {
  id: string;
  corpus_id: string | null;
  title: string;
  file_name: string;
  mime_type: string;
  char_count: number;
  chunk_count: number;
  created_at: number;
}
interface ChunkRow {
  id: string;
  document_id: string;
  idx: number;
  text: string;
  page: number | null;
  embedding: string;
}

/** Run fn inside BEGIN/COMMIT (node:sqlite has no .transaction()). */
function inTransaction(db: { exec(sql: string): void }, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

function rowToCorpus(r: CorpusRow): KbCorpus {
  return { id: r.id, name: r.name, description: r.description, createdAt: r.created_at };
}
function rowToDocument(r: DocumentRow): KbDocument {
  return {
    id: r.id,
    corpusId: r.corpus_id,
    title: r.title,
    fileName: r.file_name,
    mimeType: r.mime_type,
    charCount: r.char_count,
    chunkCount: r.chunk_count,
    createdAt: r.created_at,
  };
}

export class KnowledgeBaseStore {
  constructor(
    private readonly mdb: ModuleDb,
    private readonly embedder: Embedder = new LocalEmbedder(),
  ) {}

  // ---- Corpora -----------------------------------------------------------

  createCorpus(name: string, description = ''): KbCorpus {
    const n = name.trim().slice(0, 120);
    if (!n) throw new ValidationError('corpus name is required');
    const c: KbCorpus = { id: randomUUID(), name: n, description: description.slice(0, 500), createdAt: Date.now() };
    this.mdb.db
      .prepare('INSERT INTO mm_kb_corpora (id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(c.id, c.name, c.description, c.createdAt);
    return c;
  }

  listCorpora(): KbCorpus[] {
    const rows = this.mdb.db
      .prepare('SELECT * FROM mm_kb_corpora ORDER BY created_at DESC')
      .all() as unknown as CorpusRow[];
    return rows.map(rowToCorpus);
  }

  deleteCorpus(id: string): void {
    // Unlink documents (keep them, corpus becomes null) — safer than cascade.
    this.mdb.db.prepare('UPDATE mm_kb_documents SET corpus_id = NULL WHERE corpus_id = ?').run(id);
    const r = this.mdb.db.prepare('DELETE FROM mm_kb_corpora WHERE id = ?').run(id);
    if (r.changes === 0) throw new NotFoundError(`corpus "${id}" not found`);
  }

  // ---- Documents ----------------------------------------------------------

  async addDocument(input: {
    title: string;
    fileName: string;
    mimeType: string;
    text: string;
    corpusId?: string | null;
  }): Promise<KbDocument> {
    const title = input.title.trim().slice(0, 200) || input.fileName;
    if (!input.text.trim()) throw new ValidationError('document has no extractable text');
    const count = (
      this.mdb.db.prepare('SELECT COUNT(*) AS n FROM mm_kb_documents').get() as unknown as { n: number }
    ).n;
    if (count >= MAX_DOCS) throw new ValidationError(`document limit reached (${MAX_DOCS})`);
    if (input.corpusId) {
      const c = this.mdb.db.prepare('SELECT id FROM mm_kb_corpora WHERE id = ?').get(input.corpusId);
      if (!c) throw new NotFoundError(`corpus "${input.corpusId}" not found`);
    }

    const chunks = chunkText(input.text).slice(0, MAX_CHUNKS_PER_DOC);
    if (chunks.length === 0) throw new ValidationError('document has no extractable text');
    const vectors = await this.embedder.embed(chunks);

    const doc: KbDocument = {
      id: randomUUID(),
      corpusId: input.corpusId ?? null,
      title,
      fileName: input.fileName.slice(0, 200),
      mimeType: input.mimeType.slice(0, 100),
      charCount: input.text.length,
      chunkCount: chunks.length,
      createdAt: Date.now(),
    };
    const insDoc = this.mdb.db.prepare(
      'INSERT INTO mm_kb_documents (id, corpus_id, title, file_name, mime_type, char_count, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insChunk = this.mdb.db.prepare(
      'INSERT INTO mm_kb_chunks (id, document_id, idx, text, page, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const txn = () => {
      insDoc.run(doc.id, doc.corpusId, doc.title, doc.fileName, doc.mimeType, doc.charCount, doc.chunkCount, doc.createdAt);
      chunks.forEach((text, i) => {
        insChunk.run(randomUUID(), doc.id, i, text, null, JSON.stringify(Array.from(vectors[i])));
      });
    };
    inTransaction(this.mdb.db, txn);
    return doc;
  }

  listDocuments(corpusId?: string): KbDocument[] {
    const rows = (
      corpusId
        ? this.mdb.db.prepare('SELECT * FROM mm_kb_documents WHERE corpus_id = ? ORDER BY created_at DESC').all(corpusId)
        : this.mdb.db.prepare('SELECT * FROM mm_kb_documents ORDER BY created_at DESC').all()
    ) as unknown as DocumentRow[];
    return rows.map(rowToDocument);
  }

  getDocument(id: string): KbDocument {
    const r = this.mdb.db.prepare('SELECT * FROM mm_kb_documents WHERE id = ?').get(id) as unknown as DocumentRow | undefined;
    if (!r) throw new NotFoundError(`document "${id}" not found`);
    return rowToDocument(r);
  }

  deleteDocument(id: string): void {
    inTransaction(this.mdb.db, () => {
      this.mdb.db.prepare('DELETE FROM mm_kb_chunks WHERE document_id = ?').run(id);
      const r = this.mdb.db.prepare('DELETE FROM mm_kb_documents WHERE id = ?').run(id);
      if (r.changes === 0) throw new NotFoundError(`document "${id}" not found`);
    });
  }

  // ---- Retrieval ----------------------------------------------------------

  async query(opts: KbQueryOptions): Promise<KbRetrievedChunk[]> {
    const q = opts.query.trim();
    if (!q) throw new ValidationError('query is required');
    const topK = Math.min(Math.max(opts.topK ?? 5, 1), 20);

    let sql = `SELECT c.id, c.document_id, c.idx, c.text, c.page, c.embedding, d.title AS doc_title, d.corpus_id
               FROM mm_kb_chunks c JOIN mm_kb_documents d ON d.id = c.document_id`;
    const params: Array<string | number | null> = [];
    if (opts.corpusIds && opts.corpusIds.length > 0) {
      sql += ` WHERE d.corpus_id IN (${opts.corpusIds.map(() => '?').join(',')})`;
      params.push(...opts.corpusIds);
    }
    const rows = this.mdb.db.prepare(sql).all(...params) as unknown as Array<{
      id: string;
      document_id: string;
      idx: number;
      text: string;
      page: number | null;
      embedding: string;
      doc_title: string;
      corpus_id: string | null;
    }>;
    if (rows.length === 0) return [];

    const [qv] = await this.embedder.embed([q]);
    const scored = rows.map((r) => {
      let vec: number[];
      try {
        vec = JSON.parse(r.embedding) as number[];
      } catch {
        vec = [];
      }
      return { r, score: cosineSimilarity(qv, vec) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ r, score }) => ({
      chunkId: r.id,
      documentId: r.document_id,
      documentTitle: r.doc_title,
      corpusId: r.corpus_id,
      idx: r.idx,
      text: r.text,
      page: r.page,
      score: Math.round(score * 10000) / 10000,
    }));
  }
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * Format retrieved chunks as a cited source block for prompts/answers:
 *   [1] "chunk text…" — Document Title
 *   [2] "chunk text…" — Other Doc
 */
export function formatCitedSources(chunks: KbRetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] "${c.text.slice(0, 600)}${c.text.length > 600 ? '…' : ''}" — ${c.documentTitle}`)
    .join('\n');
}

/** Append a "Sources" section to an answer body. */
export function appendSourcesSection(answer: string, chunks: KbRetrievedChunk[]): string {
  if (chunks.length === 0) return answer;
  const lines = chunks.map((c, i) => `${i + 1}. ${c.documentTitle}${c.page != null ? ` (p. ${c.page})` : ''}`);
  return `${answer.trim()}\n\n**Sources**\n${lines.join('\n')}`;
}
