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

`extensions/ephemeral-subagents/index.ts` registers `subagent_jobs`, a read-only
investigation job service. A launch may contain one task or up to 16 parallel tasks.
Foreground launches wait for the group; background launches return job and group IDs.
Use the `status`, `collect`, `wait`, `message`, `answer`, `pause`, `resume`, and `cancel`
actions to control background jobs.

Every job receives a detached disposable Git worktree under a mode-0700 temporary
session containing only `repos/`. Bubblewrap mounts that worktree read-only at the
main repository's original absolute path, supplies a private `/tmp`, permits networking,
and exposes only required OS/runtime paths. The manager keeps events, protocol state,
and bounded output in its own memory. It kills the process group and removes both the
worktree and session on every terminal path; failed cleanup is retried.

Sandbox selection is ordered: Bubblewrap, then a per-job Podman/Docker container. To
use containers, set `PI_SUBAGENT_CONTAINER_IMAGE` to an image containing Node and `pi`.
There is intentionally no automatic unsandboxed fallback. The persisted platform policy
is `ask` by default and can be changed with:

```json
{"action":"policy","savedPolicy":"deny"}
```

Policies are `ask`, `allow`, or `deny`, saved in
`~/.pi/agent/ephemeral-subagents.json`. `fallbackOverride` changes one launch only. An
unsandboxed result is explicitly labelled either `unsandboxed by saved preference`,
`unsandboxed by per-run override`, or `unsandboxed by explicit per-run confirmation`.
Headless `ask` is denied because no confirmation UI is available.

Example tool calls:

```json
{"action":"launch","tasks":["trace authentication","locate cache invalidation"],"background":true,"concurrency":2,"runtimeMs":300000}
{"action":"status","jobId":"..."}
{"action":"message","jobId":"...","message":"Also inspect error paths","followUp":true}
{"action":"wait","groupId":"..."}
```

Limits are configurable per manager for concurrency, process count, CPU, memory, disk,
runtime, and captured output. Runtime and output limits are always enforced. Container
limits use runtime cgroups. Bubblewrap provides PID/mount/user namespaces and a
read-only repository, but Bubblewrap itself does not implement CPU, memory, process, or
scratch-disk quotas; capability notices report this host limitation rather than claiming
those quotas are active.

The control channel is a private inherited pipe with versioned, 64-KiB, HMAC-authenticated
frames. Sequence checks reject malformed, duplicate, late, and out-of-order frames. Pi's
RPC protocol supplies progress, messages/follow-ups, UI questions/answers, and structured
completion events. Cancellation wins over late answers; control loss/crashes are terminal
failures; terminal jobs reject later commands. Pausing one process group does not stop
other jobs.

Platform notes:

- Bubblewrap requires Linux user namespaces. Startup failure is a job failure and never
  triggers an unsafe fallback.
- Internet access is enabled. The manager brokers only the selected model credential,
  provider API variables, and basic proxy variables. SSH, cloud, Git, and Pi
  credential/config directories are not mounted. Providers requiring extra custom
  headers or credential files need a container-specific credential broker.
- Submodule working trees are not initialized automatically, because doing so could
  mutate shared Git module storage or require host credentials. Already committed
  gitlink entries remain visible; missing submodule content must be reported by the job.
- The container image contract and managed-VM backend are extension points; no managed
  VM backend is bundled. A shared VM must still run one container/sandbox per job.
