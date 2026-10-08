---
name: docker-basics
description: Dockerfile and Compose conventions for reproducible services.
---

# Docker Basics Skill

1. **Minimal base** — use slim/official images; pin versions (`node:22-slim`,
   not `node:latest`).
2. **Layer order** — copy dependency manifests first, install, then copy
   source. Keeps rebuilds fast.
3. **Non-root** — create and use a non-root user in the image.
4. **One process per container** — use Compose for multi-service setups.
5. **Compose** — name services, pin image versions, mount volumes for data
   that must survive restarts, use `.env` files for secrets (never bake
   secrets into images).
6. **Healthchecks** — add `HEALTHCHECK` so orchestrators know when the app is
   actually ready.
