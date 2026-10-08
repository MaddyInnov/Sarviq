---
name: shell-scripting
description: Safe, readable bash scripts.
---

# Shell Scripting Skill

1. **Strict mode** — start every script with `set -euo pipefail`.
2. **Quote everything** — `"$var"`, never bare `$var`; use arrays for
   argument lists.
3. **Fail loudly** — check exit codes of critical commands; `die()` helper
   for fatal errors with a message.
4. **Idempotency** — scripts should be safe to re-run; use `mkdir -p`,
   check-before-create.
5. **No `rm -rf` with variables** — guard: `: "${DIR:?}"` before any
   destructive command; never `rm -rf /` patterns.
6. **Document** — a usage header: what it does, arguments, examples.
