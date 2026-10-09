// SPDX-License-Identifier: Apache-2.0
// GitHub integration — the PR side of the Codex-style loop.
//
// Agent workflow: write code → git_commit → git_push → POST /api/github/pr.
// Auth: GITHUB_TOKEN env var (a classic PAT or fine-grained token with
// pull-request write scope). PR creation and reviews are network-mutating,
// so the routes require governance approval — the agent cannot open a PR
// silently.

const GITHUB_API = 'https://api.github.com';

function githubToken(): string {
  const t = process.env.GITHUB_TOKEN?.trim();
  if (!t) throw new Error('GITHUB_TOKEN is not configured');
  return t;
}

async function gh(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 2000) };
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `GitHub API ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export interface CreatePrInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function validateRepo(owner: string, repo: string): void {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
    throw new Error('owner/repo must be 1-100 chars: letters, digits, . _ -');
  }
}

export async function createPullRequest(input: CreatePrInput): Promise<unknown> {
  validateRepo(input.owner, input.repo);
  const title = input.title.trim();
  if (!title || title.length > 300) throw new Error('title is required (1-300 chars)');
  for (const b of [input.head, input.base]) {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b) || b.startsWith('-') || b.includes('..')) {
      throw new Error('Invalid branch name');
    }
  }
  return gh(`/repos/${input.owner}/${input.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      head: input.head,
      base: input.base,
      body: (input.body ?? '').slice(0, 65_000),
      draft: input.draft === true,
    }),
  });
}

export async function listPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<unknown> {
  validateRepo(owner, repo);
  return gh(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`);
}

export interface ReviewInput {
  owner: string;
  repo: string;
  number: number;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
}

export async function submitReview(input: ReviewInput): Promise<unknown> {
  validateRepo(input.owner, input.repo);
  if (!Number.isInteger(input.number) || input.number <= 0) {
    throw new Error('PR number must be a positive integer');
  }
  if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(input.event)) {
    throw new Error('event must be APPROVE, REQUEST_CHANGES, or COMMENT');
  }
  return gh(`/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      event: input.event,
      body: (input.body ?? '').slice(0, 65_000),
    }),
  });
}

/** True when the platform is configured to talk to GitHub. */
export function isGitHubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim());
}
