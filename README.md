# pi-customizations

Personal Pi extension customizations.

## Install

From this directory:

```bash
pi install .
```

## Structure

- `extensions/`
  - `personal-policy/` — enforces tool-policy behavior
  - `personal-session/` — session lifecycle hooks and workdir persistence
  - `personal-commands/` — `/yeet` and `/land` commands and workflows
  - `personal/` — shared modules and utilities:
    - `commands/` — command handler logic (e.g. `yeet`)
    - `events/` — shared event handlers
    - `utils/` — shared utilities (`git`, `exec`, workdir)
    - `types.ts` — shared extension types

## Included behavior

- Enforces a bash-only tool policy
- Adds `/yeet` for GPT-5.6 Luna commit-message, feature-branch, and PR-description generation with interactive commit/push/PR automation
- Adds `/land [PR-number-or-URL]` to merge or close GitHub PRs and optionally delete their local and remote branches (`--dry-run` previews the selected plan)
- Persists session working directory so it is restored on `/resume` and `/reload`
