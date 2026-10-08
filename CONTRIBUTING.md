# Contributing

Thanks for helping build the all-in-one AI agent platform. A few ground rules:

## Before your first PR

1. **Sign the CLA.** Our [Contributor License Agreement](CLA.md) runs automatically
   via the CLA Assistant bot on your first pull request — follow the link it posts.
   One signature covers all future contributions.
2. Read the [trust model](README.md#trust-model-trust-floor) — deny-by-default
   approvals, credential encryption, and TOFU pinning are non-negotiable.
3. Zero paid usage in tests: mock providers, `:free` models only for live checks.

## Workflow

- `npm ci && npm run build && npm test` must be green before you push.
  (Build runs before test — the api workspace imports `@mvp/*/dist/*`.)
- Node >= 22 (the codebase uses `node:sqlite`).
- Keep the six top-level destinations coherent: Chat, Bots, Workflows,
  Marketplace, Workspace, Activity. Chat is the main entry point.
- Simple/Pro modes: new UI must not confuse Simple mode.

## What we won't merge

- Hardcoded API keys or credentials of any kind (env vars only).
- Features that bypass the approval system or weaken the trust floor.
- Paid-API usage in tests.

## License

By contributing you agree your contributions are licensed under the
[Apache-2.0](LICENSE) license of this project, per the CLA.
