// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPullRequest,
  isGitHubConfigured,
  listPullRequests,
  submitReview,
} from '../src/github.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
  vi.restoreAllMocks();
});

function mockFetch(ok: boolean, body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('github api', () => {
  it('isGitHubConfigured reflects the env var', () => {
    expect(isGitHubConfigured()).toBe(false);
    process.env.GITHUB_TOKEN = 'tok';
    expect(isGitHubConfigured()).toBe(true);
  });

  it('createPullRequest throws without a token', async () => {
    await expect(
      createPullRequest({ owner: 'o', repo: 'r', title: 't', head: 'a', base: 'b' }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('createPullRequest posts to the pulls endpoint', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    mockFetch(true, { number: 42, html_url: 'https://github.com/o/r/pull/42' });
    const pr = (await createPullRequest({
      owner: 'o',
      repo: 'r',
      title: 'My PR',
      head: 'feature',
      base: 'main',
      body: 'desc',
    })) as { number: number };
    expect(pr.number).toBe(42);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls');
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.title).toBe('My PR');
    expect(payload.head).toBe('feature');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('createPullRequest validates inputs', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    await expect(
      createPullRequest({ owner: 'bad owner!', repo: 'r', title: 't', head: 'a', base: 'b' }),
    ).rejects.toThrow(/owner\/repo/);
    await expect(
      createPullRequest({ owner: 'o', repo: 'r', title: '', head: 'a', base: 'b' }),
    ).rejects.toThrow(/title/);
  });

  it('createPullRequest surfaces API errors', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    mockFetch(false, { message: 'Validation Failed' }, 422);
    await expect(
      createPullRequest({ owner: 'o', repo: 'r', title: 't', head: 'a', base: 'b' }),
    ).rejects.toThrow(/Validation Failed/);
  });

  it('listPullRequests hits the right endpoint', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    mockFetch(true, [{ number: 1 }]);
    const prs = (await listPullRequests('o', 'r', 'closed')) as Array<{ number: number }>;
    expect(prs[0].number).toBe(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls?state=closed&per_page=30');
  });

  it('submitReview validates the event', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    await expect(
      submitReview({ owner: 'o', repo: 'r', number: 1, event: 'BOGUS' as never }),
    ).rejects.toThrow(/event must be/);
  });

  it('submitReview posts a review', async () => {
    process.env.GITHUB_TOKEN = 'tok';
    mockFetch(true, { id: 7, state: 'APPROVED' });
    const review = (await submitReview({
      owner: 'o',
      repo: 'r',
      number: 5,
      event: 'APPROVE',
      body: 'lgtm',
    })) as { state: string };
    expect(review.state).toBe('APPROVED');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/5/reviews');
    expect(JSON.parse((init as RequestInit).body as string).event).toBe('APPROVE');
  });
});
