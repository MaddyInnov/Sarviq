---
name: cron-scheduling
description: Cron syntax and safe scheduling practices.
---

# Cron Scheduling Skill

1. **Syntax** — `minute hour day-of-month month day-of-week command`.
   `*/15 * * * *` = every 15 minutes; `0 22 * * *` = 22:00 daily.
2. **Absolute paths** — cron has a minimal PATH; use full paths for binaries
   and files.
3. **Environment** — set needed env vars at the top of the crontab; never
   assume your shell profile loads.
4. **Logging** — redirect stdout/stderr to a log file; silent crons hide
   failures.
5. **Overlap** — guard long jobs with a lockfile (`flock`) so a slow run
   doesn't stack up.
6. **Test first** — run the command manually as the cron user before
   scheduling.
