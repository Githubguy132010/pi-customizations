# pi-customizations

Personal Pi extension customizations.

## Install

From this directory:

```bash
pi install .
```

## Structure

- `extensions/`
  - `ask-question/` — asynchronous adaptive question queue with three suggested answers and custom input
  - `personal-policy/` — limits model tools to `bash` and `ask_question`
  - `personal-session/` — session lifecycle hooks and workdir persistence
  - `personal-commands/` — `/yeet` and `/land` commands and workflows
  - `personal/` — shared modules and utilities:
    - `commands/` — command handler logic (e.g. `yeet`)
    - `events/` — shared event handlers
    - `utils/` — shared utilities (`git`, `exec`, workdir)
    - `types.ts` — shared extension types

## Included behavior

- Limits the active model toolset to `bash` and `ask_question`
- Adds an asynchronous `ask_question` tool: the model can queue several questions, react to answers while the overlay remains open, and add, replace, or close follow-up questions
- Adds `/yeet` for GPT-5.6 Luna commit-message, feature-branch, and PR-description generation with interactive commit/push/PR automation
- Shows a clickable `PR #1234` indicator in the bottom bar when the current branch has a GitHub pull request
- Adds `/land [PR-number-or-URL]` to select one or more open GitHub PRs, merge or close them, and optionally delete their local and remote branches (`--dry-run` previews each selected plan)
- Persists session working directory so it is restored on `/resume` and `/reload`
