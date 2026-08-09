# pi-customizations

Personal Pi extension customizations.

## Install

From this directory:

```bash
pi install .
```

## Contents

- `extensions/` — custom behaviors and commands
  - Includes a session extension that:
    - enforces a bash-only tool policy,
    - shows live token-per-second in the footer,
    - adds `/yeet` for interactive commit/push/PR workflow automation.
  - Persists session working directory so it is restored on `/resume` and `/reload`.
