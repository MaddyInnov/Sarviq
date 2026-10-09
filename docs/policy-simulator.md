<!-- SPDX-License-Identifier: Apache-2.0 -->
# Policy simulator + action registry (P3-B, open-dots parity)

Two open-dots-parity additions to the governance surface.

## Policy simulator — `POST /api/policy/simulate`

Side-effect-free dry-run of the governance engine: given a tool name and
args (optionally scoped to a bot), it returns the decision the gateway
**would** make — without minting approvals and without writing audit
entries. Policy authors use it to test rules safely before they govern
real runs.

Request:

```json
POST /api/policy/simulate
{ "botId": "optional-bot-id", "toolName": "write_file", "args": { "path": "notes/todo.txt" } }
```

Response:

```json
{
  "toolName": "write_file",
  "botId": "my-bot",
  "effect": "require-approval",
  "actionClass": "write",
  "matchedRuleId": "approval-file-writes",
  "reason": "File writes mutate state",
  "wouldCreateApproval": true,
  "simulated": true
}
```

Semantics:

- With `botId`, the call is evaluated against the bot's **merged** policy
  (bot rules prepended, first match wins) — exactly the policy
  `evaluate()` would use at runtime. Omit `botId` for the global policy.
- Hard floors and the `run_command` denylist are reported explicitly
  (`hardFloor.tier`, `denylist: true`) because they override policy rules.
- `wouldCreateApproval` tells the caller a live call would pause for a
  human; the simulator itself never creates the approval record.

Implementation: `GovernanceGateway.simulate()` in
`packages/governance/src/gateway.ts`. The live path (`evaluate()` /
`evaluateWithPolicy()`) and the simulator share the same pure decision
function (`decidePolicy()`), so the simulator can never drift from the
live logic — side effects (approval minting, audit writes) are applied
only by the live path.

The Bots page has a **Policy simulator** panel under each bot's rules
editor (`apps/web/app/bots/page.tsx`) wired to the same endpoint.

## Action registry — `GET /api/tools`

Read-only listing of every tool in the agent's action registry
(name, description, parameter schema). Lets the web UI, external clients,
and the policy simulator enumerate available actions without executing
anything:

```json
GET /api/tools
{ "tools": [{ "name": "computer_click", "description": "...", "parameters": { ... } }] }
```

Helper: `getActionRegistry()` in `apps/web/lib/api.ts`.
