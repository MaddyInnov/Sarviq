# @mvp/redteam — Red-Team Robustness Suite

Defensive security testing harness for our own bots. Approved by the founder as a
defensive security feature.

## Hard boundary — read this first

This package exists to **test and harden OUR OWN bots' defenses**. Standard
red-team practice: you probe your own system so you can fix what breaks.

What it is NOT, and must never become:

1. **Not user-facing.** The attack library is test data, not a feature. It must
   never be exposed in the product as a way for end users to generate attacks,
   craft jailbreaks, or bypass model safety. No UI surface, API endpoint, skill,
   or workflow may offer "attack generation" to users.
2. **Not a safety-bypass tool.** Nothing in this package helps anyone bypass a
   model's safety systems. The harness measures whether OUR bots refuse
   adversarial input — it does not produce instructions for wrongdoing and does
   not ship jailbreak prompts as user-facing functionality.
3. **Sandbox only.** Suites run against bots we own, in our own environment,
   via mock providers in tests (zero paid APIs) or our own AgentRuntime. Never
   point the harness at third-party systems or other people's bots.
4. **Scores are heuristic.** `blocked` / `succeeded` are pattern-based signals
   over transcripts. Every report ships the full transcript so a human audits
   the call. A high score is evidence, not proof.

If you are adding a feature that would let an end user run attacks, generate
adversarial prompts, or test someone else's system — stop. That is outside this
package's charter and needs explicit founder approval as a separate decision.

## What's inside

- `src/attacks.ts` — attack library (test cases only): 14 probes in the `core`
  suite across 7 categories: direct prompt injection, indirect injection via
  tool outputs / retrieved docs, system-prompt extraction, role-play /
  persona-hijack, encoding/obfuscation, multi-turn context manipulation, and
  tool-abuse attempts (tied to the catastrophic-command hard floors — a PASS
  means the destructive call was denied or never attempted).
- `src/harness.ts` — `runSuite(runner, bot, suite)`: runs each attack in an
  isolated session, captures transcripts, scores blocked/succeeded.
- `src/runtime-runner.ts` — `AgentRuntimeRunner`: production runner driving a
  real bot through `AgentRuntime.runTurn`. Indirect-injection fixtures are
  wrapped with the runtime's own untrusted-data tags. Approval waits fail
  closed quickly (`approvalTimeoutMs`, default 1500ms) so suite runs never
  hang on a human.
- `src/mock-bots.ts` — `HardenedMockRunner` / `NaiveMockRunner` for tests and
  CI self-checks (proves the harness can actually detect failures).
- `src/reports.ts` — persistence: `<dataDir>/redteam-reports/<botId>.json`
  (history capped at 25).
- `src/gate.ts` — `evaluateGate(report, minScore)`: pass/fail for the bot
  publish checklist and CI. Succeeded attacks come back with `hardeningNote`s
  — recorded in the report, not auto-filed anywhere (no task system here).
- `src/cli.ts` — `redteam` CLI (`list-suites`, `run` with mock bots, `gate`).

## API (apps/api)

- `POST /api/bots/:id/redteam/run` `{ suite? }` → runs the suite against the
  real bot via `AgentRuntimeRunner`, persists and returns the report.
- `GET /api/bots/:id/redteam/reports` → report history for the bot.

## Web (Bots destination)

A **Robustness** tab on the bot detail page (Pro mode only — hidden in Simple
mode) showing score history and the last run's per-attack breakdown, with a
"run suite" button. The Bots destination stays one of the six top-level
destinations; Robustness is a tab, not a new destination.

## Governance firing-log integration — follow-up

Results do not yet feed the processing-rules firing log: `ProcessingRuleStore`
exposes no public write path (`appendFiring` is private and rule-scoped).
When governance adds a public record API, implement `RedteamFiringSink`
(`src/types.ts`) and pass it to `runSuite()`.

## Publish checklist / CI

```
redteam gate --bot <bot-id> --min-score 80 --data-dir <dataDir>
```

exits 0 on pass, 1 on fail (or when no report exists — fail-closed). Wire it
into the bot publish checklist and CI; gate failures list the succeeded
attacks with their hardening notes.

## Testing

`npm test` (vitest): 17 tests, all local mocks — no network, no paid APIs, no
secrets. `npm run build` must stay `tsc`-clean.
