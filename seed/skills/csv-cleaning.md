---
name: csv-cleaning
description: Checklist for turning messy CSVs into analysis-ready data.
---

# CSV Cleaning Skill

1. **Inspect raw** — open the first rows and the file encoding/delimiter
   before parsing; watch for BOMs and semicolon delimiters.
2. **Types** — coerce dates and numbers; log every coercion failure instead
   of silently dropping rows.
3. **Missing values** — distinguish empty, "N/A", "NULL", 0; decide per
   column: drop, fill, or flag — and document the choice.
4. **Duplicates** — dedupe on the natural key; report how many rows were
   removed.
5. **Text normalization** — strip whitespace, unify case for keys, normalize
   unicode where matching matters.
6. **Audit trail** — keep the raw file untouched; cleaning steps live in a
   script that can be re-run.
