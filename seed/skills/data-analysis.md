---
name: data-analysis
description: End-to-end analysis workflow: question, explore, model, report.
---

# Data Analysis Skill

1. **Question first** — write the business question and the decision it will
   inform before touching data.
2. **Profile the data** — shape, dtypes, missingness, duplicates, value
   ranges. `df.info()`, `df.describe()`, `df.isna().sum()`.
3. **Explore visually** — distributions and relationships before modeling;
   outliers are findings, not noise (until proven otherwise).
4. **Keep it simple** — a clear baseline (means, segments, linear model)
   beats a fancy model you cannot explain.
5. **Report honestly** — lead with the answer, show the method, state
   limitations and sample sizes. Never cherry-pick.
