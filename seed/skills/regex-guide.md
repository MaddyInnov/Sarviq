---
name: regex-guide
description: Building blocks for readable, correct regular expressions.
---

# Regex Guide Skill

1. **Start from examples** — write 3+ strings that must match and 3+ that must
   not before writing the pattern.
2. **Core pieces** — `.` any char, `\d` digit, `\w` word char, `\s` whitespace,
   `^`/`$` anchors, `*`/`+`/`?` quantifiers, `(...)` groups, `[...]` classes,
   `|` alternation.
3. **Greedy vs lazy** — `.*` grabs as much as possible; `.*?` grabs as little
   as possible. Prefer lazy or negated classes (`[^"]*`) for delimited text.
4. **Escape discipline** — escape `.`, `(`, `[`, `+`, `?`, `*` when literal.
5. **Readability** — prefer named groups `(?P<name>...)` and verbose mode for
   long patterns; comment what the pattern is for.
6. **Safety** — avoid nested quantifiers like `(a+)+` (catastrophic
   backtracking); test with adversarial input.
