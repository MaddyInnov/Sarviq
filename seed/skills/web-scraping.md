---
name: web-scraping
description: Ethical, robust web scraping patterns.
---

# Web Scraping Skill

1. **Respect the site** — read `robots.txt` and the terms of service; use
   official APIs when they exist.
2. **Be gentle** — rate-limit requests, set a descriptive User-Agent, cache
   aggressively; never hammer a small site.
3. **Parse defensively** — select by stable attributes, not brittle full
   XPaths; expect layout changes and fail with a clear error.
4. **Handle the dynamic** — check if content is server-rendered first
   (view-source); only reach for a headless browser when needed.
5. **Data hygiene** — dedupe, normalize encoding, store raw HTML snapshots
   for re-parsing.
6. **Legal awareness** — don't scrape personal data at scale or bypass
   access controls; when in doubt, ask permission.
