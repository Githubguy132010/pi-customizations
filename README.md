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
  - `personal-tps/` — live token-per-second / turn metrics
  - `personal-session/` — session lifecycle hooks and workdir persistence
  - `personal-commands/` — `/yeet` command and workflow
  - `personal/` — shared modules and utilities:
    - `commands/` — command handler logic (e.g. `yeet`)
    - `events/` — shared event handlers
    - `utils/` — shared utilities (`git`, `exec`, workdir)
    - `types.ts` — shared extension types

## Included behavior

- Enforces a bash-only tool policy
- Shows live token-per-second in the footer
- Adds `/yeet` for GPT-5.6 Luna commit-message generation and interactive commit/push/PR automation
- Persists session working directory so it is restored on `/resume` and `/reload`
