// SPDX-License-Identifier: Apache-2.0

# @mvp/agent-runtime

MVP agent runtime for the all-in-one AI agent SaaS platform: LLM providers,
a tool-calling agent loop with governance checkpoints, SQLite sessions, skill
loading, MCP clients, and built-in tools. Groq-first; other providers are
data-driven presets.

## Layout

```
src/
  index.ts            public surface (re-exports everything below)
  types.ts            contracts: ChatMessage, ToolCall, TokenUsage, StreamEvent,
                      ToolDefinition, BotConfig, LLMProvider, ModelInfo
  governance.ts       GovernanceGateway interface (local copy — see below)
  runtime.ts          AgentRuntime: runTurn() agent loop + previewTurn() dry-run
  sessions.ts         SessionStore over node:sqlite
  skills.ts           SkillLoader (gray-matter frontmatter)
  mcp.ts              MCPClient (stdio + streamable HTTP)
  tools/builtin.ts    createBuiltInTools(): read_file, write_file, run_command,
                      web_search, web_fetch
  providers/
    catalog.json      provider presets (DATA, not code)
    catalog.ts        load presets, resolveApiKey(), resolveBaseUrl()
    factory.ts        createProvider()
    openai-compatible.ts  SSE chat driver (Groq, OpenRouter, OpenAI, BYO)
    anthropic.ts      Anthropic Messages API driver
    mock.ts           scripted MockProvider for tests
test/                 vitest suite (30 tests)
```

## Providers

Adding a provider = adding a JSON entry in `src/providers/catalog.json`
(the build copies it to `dist/providers/`). Each preset:

```json
{
  "id": "groq",
  "name": "Groq",
  "api": "openai-compatible",
  "baseUrl": "https://api.groq.com/openai/v1",
  "envKey": "GROQ_API_KEY",
  "models": [{ "id": "openai/gpt-oss-120b", "name": "GPT-OSS 120B", "default": true }]
}
```

- `api`: `"openai-compatible"` (chat-completions + SSE) or `"anthropic"`.
- `liveModels: true` (OpenRouter): `listModels()` hits `{baseUrl}/models`, falling back to the catalog list on error.
- `byo: true` (OmniRush): bring-your-own — ships with an **empty `baseUrl`** and no
  credentials. The user enters their own endpoint + key on the Providers settings
  page; the API persists them to `data/providers.local.json` (0600) as
  `OMNIRUSH_API_KEY` / `OMNIRUSH_API_KEY_BASE_URL`. `createProvider('omnirush')`
  throws a clear configuration error until an endpoint is set, and never attempts
  a request to an empty URL. Never embed, log, or pool anyone's OmniRush
  credentials — this preset only points the platform at the user's *own* access.

Key resolution (`resolveApiKey`): env var named by `envKey` first, then
`data/providers.local.json` (path overridable via `PROVIDERS_FILE`). Keys are
never logged.

`createProvider(id)` throws a clear error naming the env var when the key is
missing (e.g. `Missing GROQ_API_KEY …`), or `Unknown provider "…"` for a bad id.

## Agent loop

```ts
const runtime = new AgentRuntime({
  dbPath: './data/agent.db',   // ':memory:' works too
  skillsDir: './skills',
  governance,                  // a GovernanceGateway implementation
  toolRegistry: new Map(tools.map(t => [t.name, t])),
  defaultProviderId: 'groq',
});

const usage = await runtime.runTurn({
  bot, message: 'Summarize this repo',
  sessionId, providerId, model,
  onEvent: (e) => { /* StreamEvent */ },
  maxIterations: 8, approvalTimeoutMs: 5 * 60_000,
});
```

Each iteration: `provider.chat()` streams `token` events; tool calls go through
`governance.classify()` + `evaluate()`:

- `deny` → `tool_result` with `denied: true`, recorded as a denial message, loop continues
- `require-approval` → `approval_required` event, then `governance.awaitDecision(approvalId)`; approved calls execute, denied ones are recorded as denials
- `allow` → collected and executed **in parallel** (`Promise.allSettled`) with pre/post hooks and audit entries

No tool calls → `done` with summed `TokenUsage`. Unknown tools and handler
exceptions become `tool_result` errors rather than crashing the turn. All
messages persist to SQLite; sessions resume via `sessionId`.

`previewTurn(bot, message)` is a dry-run: resolves provider/key/skills/tools/MCP
without calling the model or executing anything. Verdict is `blocked` when the
provider is unknown or no key is configured, `warning` when skills/tools are
missing or MCP servers are unreachable, else `ready`. `nextActions` lists the
user's fix-ups.

## Governance

`@mvp/governance` is built in parallel by a teammate; its runtime code is
deliberately **not** imported here so this package's tests stay green without it.
`src/governance.ts` documents the exact `GovernanceGateway` surface this package
needs (`classify` / `evaluate` / `awaitDecision` / `decide` / `audit` /
`runPreHooks` / `runPostHooks`). Once the teammate's package ships TypeScript
typings, replace that file with
`import type { GovernanceGateway } from '@mvp/governance'`. Tests use a local
`FakeGateway`.

## Built-in tools

`createBuiltInTools({ workspaceDir })` — `read_file`/`write_file` are confined to
`workspaceDir` (traversal throws); `run_command` runs via `sh -c` with a denylist
(`rm -rf /`, `mkfs`, `dd of=`, fork bombs), 30s default timeout, 8KB output
truncation; `web_search` uses the DuckDuckGo instant-answer API; `web_fetch`
caps at 200KB and strips HTML.

## Sessions

`SessionStore` (`node:sqlite`, loaded via `process.getBuiltinModule` — vitest
cannot statically resolve the `node:sqlite` specifier). Tables `sessions` and
`messages`; assistant tool calls persist in a JSON column so history
re-serializes correctly for providers.

## Verify

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run
```
