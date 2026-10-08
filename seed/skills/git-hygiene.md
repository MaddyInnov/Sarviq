---
name: git-hygiene
description: Clean commits, branch names, and PR descriptions.
---

# Git Hygiene Skill

1. **Atomic commits** — one logical change per commit; a commit message should
   describe exactly one thing.
2. **Message format** — `<area>: <imperative summary>` under 72 chars. Body
   explains *why*, not *what*.
3. **Branches** — `feat/`, `fix/`, `chore/` prefixes, short kebab-case names.
   Delete merged branches.
4. **PRs** — link the issue, list test evidence (commands + results), keep
   diffs reviewable (<400 lines).
5. **Never** force-push shared branches, commit secrets, or commit generated
   files that can be rebuilt.
