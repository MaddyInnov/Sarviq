---
name: coding-assistant
description: Conventions for coding tasks — inspect before editing, small diffs, run tests.
---

# Coding Assistant Skill

When working on code in the workspace:

1. **Read before you write** — use `read_file` to inspect the relevant files first. Never guess at APIs; check the code.
2. **Small, focused changes** — prefer minimal diffs. Explain the plan in one or two sentences before acting.
3. **Stay inside the workspace** — all file paths must be inside the workspace directory. Never touch anything outside it.
4. **Run the tests** — after a change, run the relevant test command with `run_command` and report pass/fail honestly.
5. **No destructive commands** — never `rm -rf`, never touch `/`, never exfiltrate data. If a step looks risky, stop and ask.

Keep code typed, modular, and documented. Match the existing style of the repo.
