---
name: testing-pytest
description: pytest patterns: fixtures, parametrization, and test layout.
---

# Testing with pytest Skill

1. **Layout** — tests mirror source: `tests/test_module.py` for
   `src/module.py`.
2. **Naming** — `test_<behavior>_<condition>`, e.g.
   `test_parse_rejects_empty_input`.
3. **Fixtures** — share setup via `@pytest.fixture`; prefer fixtures over
   inheritance.
4. **Parametrize** — `@pytest.mark.parametrize` for input/output tables
   instead of copy-pasted tests.
5. **Isolation** — tests must not depend on order; use `tmp_path` for files,
   `monkeypatch` for env/IO.
6. **Scope** — unit-test pure logic; integration-test boundaries (DB, API)
   with explicit markers (`-m "not slow"` for fast runs).
