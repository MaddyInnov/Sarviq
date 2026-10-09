// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { htmlToMarkdown, registerNotionImportRoutes } from '../src/notion-import.js';

describe('htmlToMarkdown', () => {
  it('converts headings, lists, links, code, tables, and quotes', () => {
    const md = htmlToMarkdown(`
      <html><body>
      <h1>Roadmap</h1>
      <p>See <a href="https://example.com">docs</a> and <strong>bold</strong> text.</p>
      <ul><li>one</li><li>two</li></ul>
      <blockquote>wise words</blockquote>
      <pre><code>const x = 1;</code></pre>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <hr/>
      </body></html>
    `);
    expect(md).toContain('# Roadmap');
    expect(md).toContain('[docs](https://example.com)');
    expect(md).toContain('**bold**');
    expect(md).toContain('- one');
    expect(md).toContain('> wise words');
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('A | B');
    expect(md).toContain('--- | ---');
    expect(md).toContain('---');
  });

  it('degrades unknown markup to plain text', () => {
    const md = htmlToMarkdown('<div class="page-body"><p>hello <span>world</span></p></div>');
    expect(md).toBe('hello world');
  });
});

describe('notion import HTTP routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof express>['listen']>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'notionhttp-'));
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    const router = express.Router();
    registerNotionImportRoutes(router, { dataDir: dir });
    app.use('/notion', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/notion`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = async (body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${baseUrl}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const makeZip = (): string => {
    const zipped = zipSync({
      'Notes/My Page 1a2b3c4d5e6f789012345678901234ab.html':
        strToU8('<html><body><h1>My Page</h1><p>Hello <strong>there</strong></p></body></html>'),
      'Tables/Tasks.csv': strToU8('Title,Estimate,Done\nAlpha,2,true\nBeta,5,false\n'),
      'assets/photo.png': strToU8('not-really-an-image'),
    });
    return Buffer.from(zipped).toString('base64');
  };

  it('imports a Notion ZIP: HTML → pages, CSV → databases, assets warned', async () => {
    const { status, json } = await post({ zip: makeZip() });
    expect(status).toBe(201);
    expect(json.pages).toHaveLength(1);
    expect(json.pages[0].title).toBe('My Page'); // 32-hex suffix stripped
    expect(json.pages[0].content).toContain('# My Page');
    expect(json.pages[0].content).toContain('**there**');
    expect(json.databases).toHaveLength(1);
    expect(json.databases[0].name).toBe('Tasks');
    expect(json.databases[0].rowCount).toBe(2);
    const types = Object.fromEntries(
      (json.databases[0].columns as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(types).toEqual({ Title: 'text', Estimate: 'number', Done: 'checkbox' });
    expect(json.warnings.some((w: string) => /photo\.png/.test(w))).toBe(true);
  });

  it('accepts pre-extracted files and dedupes colliding titles', async () => {
    const { status, json } = await post({
      files: [
        { name: 'a.md', content: '# A' },
        { name: 'sub/a.md', content: '# A again' }, // sub-pages flatten
        { name: 'notes.txt', content: 'nope' },
      ],
    });
    expect(status).toBe(201);
    expect(json.pages.map((p: { title: string }) => p.title)).toEqual(['a', 'a (2)']);
    expect(json.warnings.some((w: string) => /notes\.txt/.test(w))).toBe(true);
  });

  it('rejects invalid payloads', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ zip: '!!!not-base64!!!' })).status).toBe(400);
    const garbage = Buffer.from('hello world').toString('base64');
    expect((await post({ zip: garbage })).status).toBe(400);
    expect((await post({ files: [{ name: 'x.md' }] })).status).toBe(400);
  });
});
