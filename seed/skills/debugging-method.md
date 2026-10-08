---
name: debugging-method
description: Systematic debugging: reproduce, isolate, hypothesize, verify.
---

# Debugging Method Skill

1. **Reproduce first** — write the smallest script/command that triggers the
   bug reliably. No reproduction, no fix.
2. **Read the error** — the full message and stack trace, top to bottom.
   The answer is usually in the first 5 lines.
3. **Bisect** — narrow the scope: comment out halves, toggle inputs, check
   the last change that worked.
4. **Hypothesize, then test** — state the theory *before* changing code;
   change one thing at a time.
5. **Check assumptions** — print/log actual values at boundaries; the bug is
   usually where you were "sure" it was fine.
6. **Fix the cause** — not the symptom. Add a regression test so it stays
   fixed.
