---
name: python-packaging
description: Modern Python packaging: pyproject.toml, venvs, and publishing.
---

# Python Packaging Skill

1. **Project layout** — `pyproject.toml` at the root; source under `src/<pkg>/`.
2. **Metadata** — name, version, description, `requires-python`, license, and
   dependencies with version bounds in `pyproject.toml`.
3. **Environments** — one venv per project (`python -m venv .venv`); never
   install into the system Python.
4. **Locking** — commit a lock file (`uv.lock` or `requirements.txt`) so builds
   are reproducible.
5. **Publishing** — build with `python -m build`, check with `twine check`,
   upload to TestPyPI first, then PyPI.
6. **Versioning** — semantic versioning; bump via a single source of truth
   (the `version` field or `__init__.__version__`).
