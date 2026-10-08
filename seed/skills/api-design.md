---
name: api-design
description: REST API design conventions: resources, status codes, versioning.
---

# API Design Skill

1. **Resources, not verbs** — `GET /orders/{id}`, not `GET /getOrder`. Use
   plural nouns.
2. **Status codes** — 200 ok, 201 created, 204 no content, 400 bad request,
   401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 422
   validation failed, 500 server error.
3. **Consistency** — one error envelope everywhere (`{ "error": "..." }`);
   ISO-8601 timestamps; snake_case or camelCase — pick one.
4. **Versioning** — version in the path (`/v1/...`); never break existing
   clients without a new version.
5. **Pagination** — cursor-based for large lists; always return total counts
   or next cursors.
6. **Idempotency** — accept idempotency keys on `POST` endpoints that create
   resources.
