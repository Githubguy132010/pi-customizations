# pi-customizations

Personal Pi customizations, packaged as independent extensions.

## Install

From this directory:

```bash
pi install .
```

Then run `pi config` to enable or disable each customization independently. Press Tab in
`pi config` to switch between global and project-local settings.

## Extensions

| Extension | Behavior |
| --- | --- |
| `extensions/bash-only/index.ts` | Enforces a bash-only tool policy. |
| `extensions/session-workdir/index.ts` | Persists and restores each session's working directory. |
| `extensions/slash-command-visibility/index.ts` | Hides selected built-in commands from slash autocomplete. |
| `extensions/yeet/index.ts` | Adds `/yeet` for AI-assisted commits, pushes, and PR creation. |
| `extensions/land/index.ts` | Adds `/land` for merging or closing PRs and cleaning up branches. |

`/yeet` only offers its “create PR + land” workflow when the land extension is enabled.
Disabling land therefore removes both `/land` and its integration with `/yeet`.

The slash-command visibility extension hides `/name`, `/tree`, `/fork`, `/clone`,
`/compact`, `/trust`, `/export`, `/import`, `/share`, `/hotkeys`, `/changelog`, and
`/llama` from autocomplete. The commands remain executable when entered manually.

Shared implementation modules live in `extensions/shared/`; they are not extension
entrypoints and do not appear as separate toggles.

## Commands

- `/yeet` generates GPT-5.6 Luna commit messages, feature branch names, and PR
  descriptions, with interactive commit/push/PR automation.
- `/land [PR-number-or-URL]` selects one or more open GitHub PRs, merges or closes
  them, and optionally deletes their local and remote branches. Add `--dry-run` to
  preview each selected plan.

## Development

```bash
npm run check       # Type-check and run the test suite
npm run test:watch  # Run tests in watch mode
npm run coverage    # Generate text and HTML coverage reports
```

The tests use Vitest and mocked Pi APIs/command execution, so they do not modify real
repositories, sessions, branches, or pull requests.
