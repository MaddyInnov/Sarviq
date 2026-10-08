---
name: prompt-engineering
description: Patterns for reliable, high-quality model outputs.
---

# Prompt Engineering Skill

1. **Role + task + format** — every prompt names the role, the exact task,
   and the output format.
2. **Examples beat adjectives** — show one good input/output pair instead of
   saying "high quality".
3. **Constraints** — length limits, structure, and what to avoid ("no
   hype", "cite sources").
4. **Decompose** — hard tasks become pipelines: draft → critique → revise,
   not one giant prompt.
5. **Test the edges** — try ambiguous and adversarial inputs; the prompt that
   survives those is the one you ship.
6. **Version prompts** — treat prompts like code: name, version, changelog.
