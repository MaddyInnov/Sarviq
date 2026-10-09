// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildMcpAuthUrl,
  codeChallengeS256,
  discoverAuthorizationServerMetadata,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateOAuthState,
  McpOAuthClient,
  McpOAuthRequiredError,
  parseAuthorizationServerMetadata,
  refreshAccessToken,
  registerOAuthClient,
  type FetchFn,
  type McpOAuthTokenStore,
  type McpOAuthTokens,
} from '../src/mcp-oauth.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): FetchFn {
  return (async (url: unknown, init?: unknown) => {
    const result = handler(String(url), init as RequestInit | undefined);
    if (result instanceof Error) throw result;
    const { ok = true, status = 200, body = {} } = result as {
      ok?: boolean;
      status?: number;
      body?: unknown;
    };
    return {
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response;
  }) as unknown as FetchFn;
}

function memoryStore(): McpOAuthTokenStore & { tokens: Map<string, McpOAuthTokens> } {
  const tokens = new Map<string, McpOAuthTokens>();
  const clients = new Map<string, { clientId: string; clientSecret?: string }>();
  return {
    tokens,
    getTokens: (id) => tokens.get(id),
    saveTokens: (id, t) => { tokens.set(id, t); },
    removeTokens: (id) => tokens.delete(id),
    getClientInfo: (id) => clients.get(id),
    saveClientInfo: (id, c) => { clients.set(id, c); },
  };
}

const METADATA = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  code_challenge_methods_supported: ['S256'],
};

describe('PKCE', () => {
  it('generates a verifier in the 43–128 char range, base64url', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars, deterministic length
    expect(v).toHaveLength(43);
  });

  it('generates unique verifiers', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('computes the RFC 7636 S256 test vector', () => {
    // RFC 7636 Appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates an opaque state', () => {
    const s = generateOAuthState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateOAuthState()).not.toBe(s);
  });
});

describe('metadata discovery', () => {
  it('parses a valid metadata document', () => {
    const meta = parseAuthorizationServerMetadata(METADATA);
    expect(meta.issuer).toBe('https://auth.example.com');
    expect(meta.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(meta.token_endpoint).toBe('https://auth.example.com/token');
    expect(meta.registration_endpoint).toBe('https://auth.example.com/register');
  });

  it('rejects metadata missing required fields', () => {
    expect(() => parseAuthorizationServerMetadata({})).toThrow(/issuer/);
    expect(() =>
      parseAuthorizationServerMetadata({ issuer: 'x', authorization_endpoint: 'y' }),
    ).toThrow(/token_endpoint/);
    expect(() => parseAuthorizationServerMetadata(null)).toThrow(/JSON object/);
  });

  it('discovers via the path-scoped well-known URI first', async () => {
    const seen: string[] = [];
    const fetchFn = mockFetch((url) => {
      seen.push(url);
      return { body: METADATA };
    });
    const meta = await discoverAuthorizationServerMetadata('https://mcp.example.com/api/v1', fetchFn);
    expect(meta.issuer).toBe('https://auth.example.com');
    expect(seen[0]).toBe('https://mcp.example.com/.well-known/oauth-authorization-server/api/v1');
  });

  it('falls back to the origin-scoped well-known URI', async () => {
    const seen: string[] = [];
    const fetchFn = mockFetch((url) => {
      seen.push(url);
      if (seen.length === 1) return { ok: false, status: 404 };
      return { body: METADATA };
    });
    const meta = await discoverAuthorizationServerMetadata('https://mcp.example.com/api/v1', fetchFn);
    expect(meta.token_endpoint).toBe('https://auth.example.com/token');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe('https://mcp.example.com/.well-known/oauth-authorization-server');
  });

  it('throws when all candidates fail', async () => {
    const fetchFn = mockFetch(() => ({ ok: false, status: 404 }));
    await expect(
      discoverAuthorizationServerMetadata('https://mcp.example.com/', fetchFn),
    ).rejects.toThrow(/metadata discovery failed/);
  });

  it('rejects invalid server URLs', async () => {
    await expect(discoverAuthorizationServerMetadata('not-a-url')).rejects.toThrow(/Invalid MCP server URL/);
  });
});

describe('authorization URL', () => {
  it('builds a PKCE authorization URL with resource indicator', () => {
    const url = buildMcpAuthUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: 'http://localhost:4000/api/mcp/oauth/callback',
      codeChallenge: 'challenge-abc',
      state: 'state-xyz',
      scope: 'read write',
      resource: 'https://mcp.example.com/',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://auth.example.com/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('client-123');
    expect(u.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    expect(u.searchParams.get('scope')).toBe('read write');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/');
  });
});

describe('token exchange', () => {
  it('exchanges a code for tokens with PKCE verifier', async () => {
    let posted: URLSearchParams | undefined;
    const fetchFn = mockFetch((_url, init) => {
      posted = new URLSearchParams(init?.body as string);
      return {
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' },
      };
    });
    const tokens = await exchangeCodeForTokens(
      {
        tokenEndpoint: 'https://auth.example.com/token',
        code: 'auth-code',
        redirectUri: 'http://localhost:4000/api/mcp/oauth/callback',
        codeVerifier: 'verifier-abc',
        client: { clientId: 'client-123' },
        resource: 'https://mcp.example.com/',
      },
      fetchFn,
    );
    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3599_000);
    expect(posted?.get('grant_type')).toBe('authorization_code');
    expect(posted?.get('code')).toBe('auth-code');
    expect(posted?.get('code_verifier')).toBe('verifier-abc');
    expect(posted?.get('resource')).toBe('https://mcp.example.com/');
  });

  it('throws on token endpoint errors', async () => {
    const fetchFn = mockFetch(() => ({
      ok: false,
      status: 400,
      body: { error: 'invalid_grant', error_description: 'bad code' },
    }));
    await expect(
      exchangeCodeForTokens(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          code: 'bad',
          redirectUri: 'http://x/cb',
          codeVerifier: 'v',
          client: { clientId: 'c' },
        },
        fetchFn,
      ),
    ).rejects.toThrow(/invalid_grant|bad code/);
  });

  it('throws when the response has no access_token', async () => {
    const fetchFn = mockFetch(() => ({ body: { expires_in: 60 } }));
    await expect(
      exchangeCodeForTokens(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          code: 'c',
          redirectUri: 'http://x/cb',
          codeVerifier: 'v',
          client: { clientId: 'c' },
        },
        fetchFn,
      ),
    ).rejects.toThrow(/access_token/);
  });

  it('refreshes an access token, keeping the old refresh token when omitted', async () => {
    let posted: URLSearchParams | undefined;
    const fetchFn = mockFetch((_url, init) => {
      posted = new URLSearchParams(init?.body as string);
      return { body: { access_token: 'at-2', expires_in: 1800 } };
    });
    const tokens = await refreshAccessToken(
      {
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt-1',
        client: { clientId: 'client-123', clientSecret: 'shh' },
      },
      fetchFn,
    );
    expect(tokens.accessToken).toBe('at-2');
    expect(posted?.get('grant_type')).toBe('refresh_token');
    expect(posted?.get('refresh_token')).toBe('rt-1');
    expect(posted?.get('client_secret')).toBe('shh');
  });
});

describe('dynamic client registration', () => {
  it('registers and returns client credentials', async () => {
    let posted: Record<string, unknown> | undefined;
    const fetchFn = mockFetch((_url, init) => {
      posted = JSON.parse(init?.body as string) as Record<string, unknown>;
      return { body: { client_id: 'dyn-1', client_secret: 'dyn-secret' } };
    });
    const info = await registerOAuthClient(
      {
        registrationEndpoint: 'https://auth.example.com/register',
        redirectUris: ['http://localhost:4000/api/mcp/oauth/callback'],
      },
      fetchFn,
    );
    expect(info.clientId).toBe('dyn-1');
    expect(info.clientSecret).toBe('dyn-secret');
    expect(posted?.redirect_uris).toEqual(['http://localhost:4000/api/mcp/oauth/callback']);
  });

  it('throws on registration failure', async () => {
    const fetchFn = mockFetch(() => ({ ok: false, status: 400, body: { error: 'invalid_client_metadata' } }));
    await expect(
      registerOAuthClient({ registrationEndpoint: 'https://auth.example.com/register', redirectUris: ['http://x'] }, fetchFn),
    ).rejects.toThrow(/registration failed/);
  });
});

describe('McpOAuthClient', () => {
  const serverId = 'test-mcp';
  const serverUrl = 'https://mcp.example.com/';

  function makeClient(store: McpOAuthTokenStore, fetchFn: FetchFn) {
    return new McpOAuthClient({
      serverId,
      serverUrl,
      store,
      resolveClient: async () => ({ clientId: 'client-123' }),
      fetchFn,
    });
  }

  it('returns the cached token when valid', async () => {
    const store = memoryStore();
    store.saveTokens(serverId, {
      accessToken: 'valid-at',
      expiresAt: Date.now() + 3600_000,
    });
    const fetchFn = mockFetch(() => {
      throw new Error('must not hit network');
    });
    const client = makeClient(store, fetchFn);
    expect(await client.getValidAccessToken()).toBe('valid-at');
  });

  it('throws McpOAuthRequiredError with the start URL when no tokens exist', async () => {
    const store = memoryStore();
    const fetchFn = mockFetch(() => ({ body: METADATA }));
    const client = makeClient(store, fetchFn);
    const err = await client.getValidAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(McpOAuthRequiredError);
    expect((err as McpOAuthRequiredError).serverId).toBe(serverId);
    expect((err as McpOAuthRequiredError).startUrl).toBe('/api/mcp/oauth/start?server=test-mcp');
  });

  it('refreshes an expired token and persists the new one', async () => {
    const store = memoryStore();
    store.saveTokens(serverId, {
      accessToken: 'expired-at',
      refreshToken: 'rt-1',
      expiresAt: Date.now() - 1000,
    });
    const fetchFn = mockFetch((url) => {
      if (String(url).includes('.well-known')) return { body: METADATA };
      return { body: { access_token: 'fresh-at', refresh_token: 'rt-2', expires_in: 3600 } };
    });
    const client = makeClient(store, fetchFn);
    expect(await client.getValidAccessToken()).toBe('fresh-at');
    expect(store.getTokens(serverId)?.accessToken).toBe('fresh-at');
    expect(store.getTokens(serverId)?.refreshToken).toBe('rt-2');
  });

  it('drops dead tokens and throws McpOAuthRequiredError when refresh fails (401)', async () => {
    const store = memoryStore();
    store.saveTokens(serverId, {
      accessToken: 'expired-at',
      refreshToken: 'revoked-rt',
      expiresAt: Date.now() - 1000,
    });
    const fetchFn = mockFetch((url) => {
      if (String(url).includes('.well-known')) return { body: METADATA };
      // Simulate the 401-revoked refresh token case.
      return { ok: false, status: 401, body: { error: 'invalid_grant' } };
    });
    const client = makeClient(store, fetchFn);
    const err = await client.getValidAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(McpOAuthRequiredError);
    expect(store.getTokens(serverId)).toBeUndefined();
  });

  it('throws McpOAuthRequiredError when the token expired without a refresh token', async () => {
    const store = memoryStore();
    store.saveTokens(serverId, { accessToken: 'expired-at', expiresAt: Date.now() - 1000 });
    const fetchFn = mockFetch(() => ({ body: METADATA }));
    const client = makeClient(store, fetchFn);
    await expect(client.getValidAccessToken()).rejects.toBeInstanceOf(McpOAuthRequiredError);
    expect(store.getTokens(serverId)).toBeUndefined();
  });

  it('buildAuthorizationUrl discovers metadata and builds the URL', async () => {
    const store = memoryStore();
    const fetchFn = mockFetch(() => ({ body: METADATA }));
    const client = makeClient(store, fetchFn);
    const url = await client.buildAuthorizationUrl({
      state: 's1',
      codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      redirectUri: 'http://localhost:4000/api/mcp/oauth/callback',
    });
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(u.searchParams.get('client_id')).toBe('client-123');
    expect(u.searchParams.get('resource')).toBe(serverUrl);
  });

  it('handleCallback exchanges the code and saves tokens', async () => {
    const store = memoryStore();
    const fetchFn = mockFetch((url) => {
      if (String(url).includes('.well-known')) return { body: METADATA };
      return { body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200 } };
    });
    const client = makeClient(store, fetchFn);
    const tokens = await client.handleCallback({
      code: 'code-123',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://localhost:4000/api/mcp/oauth/callback',
    });
    expect(tokens.accessToken).toBe('new-at');
    expect(store.getTokens(serverId)?.accessToken).toBe('new-at');
  });
});
