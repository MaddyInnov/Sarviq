# @mvp/governance

SPDX-License-Identifier: Apache-2.0

Deny-by-default action gateway for the MVP agent platform. Every tool call an
agent wants to make is classified, matched against a policy (first rule wins,
otherwise the default effect applies), and resolved to **allow**,
**require-approval**, or **deny**. Human decisions and every evaluation are
persisted in SQLite (`node:sqlite`), and the audit log is secret-redacted.

## Quick start

```ts
import {
  GovernanceGateway,
  DEFAULT_POLICY,
} from '@mvp/governance';

const gw = new GovernanceGateway({ dbPath: './data/governance.sqlite', policy: DEFAULT_POLICY });

const res = await gw.evaluate('write_file', { path: 'notes.txt' }, {
  sessionId: 'sess-1',
  botId: 'bot-1',
  actor: 'ashutosh',
});

if (res.effect === 'allow') {
  // run the tool
} else if (res.effect === 'require-approval' && res.approvalId) {
  // show the approval card to a human; the agent waits:
  const decision = await gw.awaitDecision(res.approvalId); // 'approved' | 'denied'
  if (decision === 'approved') {
    // run the tool
  }
} else {
  // denied — do not run the tool
}
```

A human (or the UI approval inbox) decides pending approvals:

```ts
gw.decide(approvalId, 'approved', { decidedBy: 'ashutosh', note: 'fine to write' });
gw.listApprovals('pending'); // newest first
gw.listAudit(50);            // newest first
```

## Policy semantics

- **Deny-by-default**: `DEFAULT_POLICY.defaultEffect` is `'require-approval'`,
  so any tool with no matching rule pauses for a human.
- **Read-only auto-allow**: `read_file`, `web_search`, `web_fetch` (classified
  `read`) are allowed without approval.
- **MCP passthrough**: tools named `mcp__*` auto-allow — they run inside the
  connector trust boundary. This is permissive: if an MCP server exposes write
  tools you do not trust, add explicit rules with `effect: 'deny'` or
  `'require-approval'` before the passthrough rule.
- **Writes, execution, network, destructive names** require approval.
- **Hard denylist** (checked before any rule, unconditional `deny`): a
  `run_command` whose `args.command` matches
  `/\brm\s+-rf\s+\/$|mkfs|:?\(\)\s*\{/` (root wipe, `mkfs`, shell fork bombs).
  Denied calls are audited.
- Rule `toolPattern`s are compiled as **case-insensitive** RegExps matched
  against the tool name. An invalid pattern fails closed (never matches).
- Unknown tools classify as `write` (conservative), so under the default
  policy they require approval rather than auto-running.

## Secrets never reach the audit log

`redactSecrets()` recursively replaces values stored under secret-like keys
(`/api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie/i`)
with `[REDACTED]`. It is applied to:

- approval arg snapshots (`ApprovalRecord.args`, persisted as `args_json`),
- every audit `detail` (JSON-stringified *after* redaction).

The input is never mutated. Cycle-safe.

## Hooks

```ts
gw.addPreHook(async (toolName, args, ctx) => { /* e.g. dry-run preview */ });
gw.addPostHook(async (toolName, args, result, ctx) => { /* e.g. token/cost tracking */ });

await gw.runPreHooks(toolName, args, ctx);   // before tool execution
await gw.runPostHooks(toolName, args, result, ctx); // after tool execution
```

The agent runtime calls `runPreHooks`/`runPostHooks` around tool execution.

## API

| Method | Description |
|---|---|
| `classify(toolName)` | Map a tool name to `read \| write \| execute \| network`. |
| `evaluate(toolName, args, ctx)` | Policy decision; creates a pending approval for `require-approval`. |
| `awaitDecision(approvalId, timeoutMs?)` | Wait for a decision; on timeout marks the approval `expired` and resolves `'denied'` (fail closed). |
| `decide(approvalId, decision, opts?)` | Human decision; throws unless the approval is `pending`. Resolves in-flight waiters and audits. |
| `listApprovals(status?)` / `getApproval(id)` | Read approvals. |
| `audit(action, fields?)` | Append an audit entry (secret-redacted). |
| `listAudit(limit?, offset?)` | Read the audit log, newest first. |
| `addPreHook` / `addPostHook` / `runPreHooks` / `runPostHooks` | Governance hooks. |
| `close()` | Release the SQLite connection. |

## SQLite schema

```sql
approvals(id TEXT PK, ts INTEGER, session_id, bot_id, actor, tool_name,
          args_json, status, decided_at, decided_by, note);
audit_log(id INTEGER PK AUTOINCREMENT, ts, actor, session_id, action,
          tool_name, decision, detail);
```

Pass `dbPath: ':memory:'` for an ephemeral database (used by tests).

## Develop

```bash
npx tsc -p tsconfig.json --noEmit   # typecheck src
npx tsc -p tsconfig.test.json --noEmit  # typecheck src + tests
npx vitest run                       # tests
npm run build                          # emits dist/
```
