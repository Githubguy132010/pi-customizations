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
| `extensions/ephemeral-subagents/index.ts` | Runs isolated, ephemeral read-only investigation subagents. |

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

### Ephemeral subagents

`extensions/ephemeral-subagents/index.ts` registers `subagent_jobs`, a repository
investigation job service. A launch may contain one task or up to 16 parallel tasks.
Foreground launches wait for the group; background launches return job and group IDs.
Use the `status`, `collect`, `wait`, `message`, `answer`, `pause`, `resume`, and `cancel`
actions to control background jobs.

Every job receives a detached disposable Git worktree under a mode-0700 temporary
session containing only `repos/`. The subagent runs in that worktree as a normal host
process. On completion, failure, timeout, or cancellation, the process group is stopped
and the worktree and session are removed. Failed cleanup is retried.

**Security:** jobs are not sandboxed. They are instructed to investigate read-only and
changes in their disposable worktree are discarded, but commands still have the same
host filesystem and network access as Pi. Do not delegate untrusted prompts or code.
Results explicitly report `none (host process)` and `sandboxed: false`.

Example tool calls:

```json
{"action":"launch","tasks":["trace authentication","locate cache invalidation"],"background":true,"concurrency":2,"runtimeMs":300000}
{"action":"status","jobId":"..."}
{"action":"message","jobId":"...","message":"Also inspect error paths","followUp":true}
{"action":"wait","groupId":"..."}
```

Concurrency, worktree disk, runtime, and captured-output limits are configurable. The
private inherited control pipe retains versioned, 64-KiB, HMAC-authenticated frames.
Cancellation wins over late answers, control loss and crashes are terminal failures, and
pausing one process group does not stop parallel jobs.

Submodules are not initialized automatically because doing so can mutate shared Git
module storage. Already committed gitlink entries remain visible.
