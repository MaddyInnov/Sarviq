---
name: typescript-patterns
description: TypeScript idioms: strict types, narrowing, and error handling.
---

# TypeScript Patterns Skill

1. **Strict on** — `strict: true`; avoid `any` — use `unknown` + narrowing.
2. **Narrowing** — `typeof`/`in`/`Array.isArray` checks and discriminated
   unions instead of casts.
3. **Exhaustiveness** — `never` checks in switch statements so new union
   members fail loudly.
4. **Errors** — typed error classes with a `code` field; helpers like
   `isNotFound(err)` instead of string matching.
5. **Async** — always `await` promises you care about; handle rejections;
   `Promise.all` for independent work.
6. **Boundaries** — validate untrusted input (request bodies, file contents)
   with type guards before use.
