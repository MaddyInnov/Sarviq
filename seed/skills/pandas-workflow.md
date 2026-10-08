---
name: pandas-workflow
description: Idiomatic pandas: vectorization, grouping, and merging.
---

# pandas Workflow Skill

1. **Vectorize** — operate on whole columns; avoid `iterrows()` except as a
   last resort.
2. **Method chains** — `df.query().assign().groupby().agg()` reads top to
   bottom; assign intermediate results sparingly.
3. **Groupby-agg** — aggregate with named aggregations:
   `df.groupby("g").agg(mean_x=("x", "mean"))`.
4. **Merges** — specify `on`, and `how` explicitly; use `validate=` to catch
   unexpected duplicates; check row counts before/after.
5. **Dtypes** — parse dates at load (`parse_dates`); use `category` for
   low-cardinality strings; downcast numerics for big frames.
6. **No chained assignment** — use `.loc[]`; enable copy-on-write.
