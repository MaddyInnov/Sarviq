---
name: code-review
description: Checklist for reviewing code: correctness, security, maintainability.
---

# Code Review Skill

Review in this order:

1. **Correctness** — does it do what it claims? Check edge cases, off-by-one
   errors, null handling, and error paths.
2. **Security** — injection (SQL/command), auth checks, secret handling,
   untrusted input validation.
3. **Maintainability** — naming, function length, duplication, comments that
   explain *why*.
4. **Tests** — is the new behavior covered? Do existing tests still pass?

Cite file + line for every finding. Suggest a concrete fix. Keep feedback
actionable and kind; approve when the code is good enough, not perfect.
