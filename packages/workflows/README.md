# @mvp/workflows

Minimal **durable DAG workflow runner** for the MVP: define a workflow as a
directed acyclic graph of typed nodes, run it, pause it for human approval,
and inspect every run from SQLite.

## Concepts

- **WorkflowDefinition** — `{ id, name, description?, nodes, edges }` where
  `edges` are `[fromId, toId]` pairs. Exactly one node must be of type
  `trigger`; the graph must be a DAG (cycles are rejected at `register` time).
- **WorkflowRun** — one execution of a definition: run status plus a
  `NodeState` per node (`pending | running | succeeded | failed | paused | skipped`).
- Execution is **level-by-level topological order** from the trigger node:
  nodes in the same level (fan-out) run concurrently; a level only starts once
  every node in the previous level finished (join = wait for all incoming edges).
  A node failure marks the run `failed` and stops it (no retries in MVP).
- **Durability** — every node-state transition and run-status change is
  persisted to SQLite (`node:sqlite`) immediately and broadcast to
  `onRunUpdate` subscribers (the API layer uses this for SSE).

## Node types

| type       | config | behavior |
|------------|--------|----------|
| `trigger`  | — | output = the run input |
| `agent`    | `{ botId, prompt }` | prompt is a template (`{{input}}`, `{{nodes.<id>.output}}`); runs one `agentRuntime.runTurn` with a synthetic session; output = final assistant text |
| `tool`     | `{ tool, args }` | args templated; goes through governance `evaluate` → `require-approval` pauses the run until `awaitDecision` resolves; approved → handler runs; denied → node failed |
| `http`     | `{ method?, url, headers?, body? }` | url/body templated; `fetch`; output `{ status, body }` (JSON parsed, else text truncated to 20 KB) |
| `delay`    | `{ seconds }` | sleeps |
| `approval` | `{ message }` | creates a governance approval (`toolName: 'workflow-approval'`); node+run go `paused`; approved → `{ approved: true }`; denied → run failed |

Template interpolation (`renderTemplate` in `src/template.ts`) recursively
replaces `{{input}}`, `{{input.a.b}}`, `{{nodes.<id>.output}}` and
`{{nodes.<id>.output.a.b}}` in strings. A string that is exactly one
placeholder resolves to the raw value (objects/arrays preserved); embedded
placeholders are string-interpolated.

## Usage

```ts
import { WorkflowRunner } from '@mvp/workflows';
import type { AgentRuntime } from '@mvp/agent-runtime';
import type { GovernanceGateway } from '@mvp/governance';

const runner = new WorkflowRunner({
  dbPath: './data/workflows.sqlite', // or ':memory:' for tests
  agentRuntime,   // live instance, received via constructor
  governance,     // live instance, received via constructor
  tools,          // Map<string, ToolDefinition>
  bots,           // Map<string, BotConfig>
});

runner.register({
  id: 'summarize-and-store',
  name: 'Summarize and store',
  nodes: [
    { id: 'trigger', type: 'trigger', name: 'Trigger', config: {} },
    { id: 'summarize', type: 'agent', name: 'Summarize',
      config: { botId: 'bot-1', prompt: 'Summarize: {{input.text}}' } },
    { id: 'save', type: 'tool', name: 'Save',
      config: { tool: 'store-note', args: { text: '{{nodes.summarize.output}}' } } },
  ],
  edges: [['trigger', 'summarize'], ['summarize', 'save']],
});

// Idempotent start: same key twice returns the existing run, no re-execution.
const run = await runner.startRun('summarize-and-store', { text: '...' },
  { idempotencyKey: 'req-42' });

// SSE-style subscription for the API layer.
const unsubscribe = runner.onRunUpdate((updated) => sendSSE(updated));

// Wait for a terminal state (succeeded/failed); rejects on timeout.
const finished = await runner.awaitRun(run.id);

runner.getRun(run.id);      // snapshot from SQLite
runner.listRuns('summarize-and-store'); // newest first
```

## API surface

- `register(def)` — validates (unique node ids, edges reference nodes,
  exactly one trigger, DAG) then persists the definition. Throws on violation.
- `listWorkflows()` / `getWorkflow(id)`
- `startRun(workflowId, input, { idempotencyKey? })` — creates the run,
  persists it, and executes **asynchronously** (does not block the caller).
- `getRun(id)` / `listRuns(workflowId?)` (newest first)
- `awaitRun(id, timeoutMs = 120_000)`
- `onRunUpdate(cb): () => void` — subscribe/unsubscribe; fired after every
  node-state transition and run-status change.

## Sibling-package types

`AgentRuntime`, `ToolDefinition`, `BotConfig`, `StreamEvent`
(`@mvp/agent-runtime`) and `GovernanceGateway` (`@mvp/governance`) are imported
**as types only**; live instances arrive via the constructor. The sibling
packages are being built in parallel and have no compiled types yet, so
`src/deps.d.ts` holds minimal ambient declarations of the exact surface this
package uses. TypeScript prefers real `node_modules` types over ambient
declarations, so these shims are automatically shadowed once the siblings are
built — if the real surfaces differ, this package will fail to compile against
them and `deps.d.ts` must be updated.

## Implementation notes

- `node:sqlite` (`DatabaseSync`) is loaded at runtime via
  `process.getBuiltinModule('node:sqlite')` because vitest's Vite 5 pipeline
  cannot statically resolve the specifier (it predates the builtin and strips
  the `node:` prefix). The `import type` stays for the type annotation only.
- Pausing is state, not machinery: while a node awaits a governance decision
  its status (and the run's) is `paused` and persisted; when the decision
  arrives the same in-flight execution continues. Resume-after-process-restart
  is not implemented in MVP.
- Nodes unreachable from the trigger are marked `skipped` at run creation so
  they can never block completion.

## Development

```bash
npx tsc -p tsconfig.json --noEmit  # typecheck
npx vitest run                     # tests (12, all with in-memory SQLite + fakes)
npm run build                      # emit to dist/
```

## License

Apache-2.0 — see the `// SPDX-License-Identifier: Apache-2.0` header on every source file.
