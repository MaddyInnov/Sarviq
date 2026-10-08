---
name: sql-helper
description: SQL patterns: joins, aggregation, window functions, and indexes.
---

# SQL Helper Skill

1. **Know your engine** — syntax differs (Postgres vs MySQL vs SQLite). Ask
   which engine before writing non-trivial SQL.
2. **Joins** — `INNER` for matches, `LEFT` to keep the left side; never use
   implicit comma joins.
3. **Aggregation** — `GROUP BY` every non-aggregated select column; filter
   groups with `HAVING`, rows with `WHERE`.
4. **Window functions** — `ROW_NUMBER()`, `LAG()`, running totals with
   `SUM(x) OVER (PARTITION BY ... ORDER BY ...)` avoid self-joins.
5. **CTEs** — `WITH` clauses for readability; one logical step per CTE.
6. **Performance** — `EXPLAIN` before optimizing; index the columns in `WHERE`,
   `JOIN ... ON`, and `ORDER BY`; avoid `SELECT *` in production queries.
7. **Safety** — parameterize all user input; never concatenate values into SQL.
