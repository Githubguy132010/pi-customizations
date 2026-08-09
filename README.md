# pi-customizations

Personal Pi extension customizations.

## Install

From this directory:

```bash
pi install .
```

## Structure

- `extensions/`
  - `personal/`
    - `index.ts` — extension entrypoint that wires hooks/commands
    - `commands/` — command handlers (e.g. `yeet`)
    - `events/` — session/turn event handlers and tool policy
    - `utils/` — shared utilities (`git`, `exec`, workdir)
    - `types.ts` — shared extension types

## Included behavior

- Enforces a bash-only tool policy
- Shows live token-per-second in the footer
- Adds `/yeet` for interactive commit/push/PR workflow automation
- Persists session working directory so it is restored on `/resume` and `/reload`
