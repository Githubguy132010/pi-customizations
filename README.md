# @thatrandomnerd69/pi-coding-agent

An opinionated, standalone Pi coding agent distribution with a small set of workflow customizations built in.

It bundles the Pi runtime and all included extensions into a single CLI, while preserving Pi's normal authentication, sessions, settings, modes, and command-line options.

## Installation

Requires Node.js 22.19 or newer.

```bash
npm install --global @thatrandomnerd69/pi-coding-agent
pi-coding-agent
```

A separate Pi installation is not required.

To check both the distribution build and bundled upstream Pi version:

```bash
pi-coding-agent --version
# @thatrandomnerd69/pi-coding-agent build 4f9c2a7d81b3 (Pi 0.84.1)
```

## Included customizations

The standalone CLI always loads all six bundled extensions.

| Extension | What it does |
| --- | --- |
| `bash-only` | Enforces a bash-only tool policy. |
| `ephemeral-subagents` | Runs short-lived agents in isolated Git worktrees with lifecycle management. |
| `session-workdir` | Persists and restores each session's working directory. |
| `slash-command-visibility` | Hides selected built-in commands from slash autocomplete. |
| `yeet` | Adds `/yeet` for AI-assisted commits, pushes, and PR creation. |
| `settle` | Adds `/settle` for merging or closing PRs and cleaning up branches. |

Extension entrypoints live under `extensions/<name>/index.ts`. Shared implementation modules live in `extensions/shared/` and are not separate extensions.

### Slash-command visibility

The following built-in commands are hidden from autocomplete:

`/name`, `/tree`, `/fork`, `/clone`, `/compact`, `/trust`, `/export`, `/import`, `/share`, `/hotkeys`, `/changelog`, and `/llama`.

They remain executable when entered manually.

### Ephemeral subagents

The `ephemeral_agent` tool supports foreground and background runs, status/result reads, follow-up messages, cancellation, and deliberate cleanup. Workspaces live under the repository's Git-ignored `.pi-agents/<session>/<agent>/` directory. Cleanup first archives the final lifecycle record (including the final answer and `git status` change summary) under the repository's Git common directory, then removes the worktree and private workspace.

Linux and WSL require `bubblewrap`; the child process receives a minimal system view plus only its own writable `repo` and `scratch` directories. The Pi distribution must be installed outside the working repository—development entrypoints are rejected because making one executable inside the parent checkout visible would violate the isolation contract. Native Windows is unsupported. The macOS `sandbox-exec` backend is experimental and its contract is exercised in macOS CI; it should not yet be treated as equivalent to the Linux security boundary.

Background parallelism defaults to four agents and can be configured with `PI_SUBAGENT_CONCURRENCY`. Child agents do not receive `ephemeral_agent`, preventing recursive spawning; they instead receive `request_parent_input` for explicit bidirectional handoffs.

## Custom commands

### `/yeet`

Generates GPT-5.6 Luna commit messages, feature branch names, and PR descriptions, then provides interactive commit, push, and PR automation.

Its optional **create PR + settle** flow is only available when the `settle` extension is enabled.

### `/settle [PR-number-or-URL]`

Selects one or more open GitHub pull requests, merges or closes them, and can optionally delete their local and remote branches.

Use `--dry-run` to preview the selected plan without applying it.

## Development

```bash
npm install
npm run check       # Type-check and run the test suite
npm run test:watch  # Run tests in watch mode
npm run coverage    # Generate text and HTML coverage reports
npm link            # Link this checkout globally
pi-coding-agent     # Run the linked CLI
```

Tests use Vitest with mocked Pi APIs and command execution, so they do not modify real repositories, sessions, branches, or pull requests.

## Publishing

Every published build uses a commit-addressed prerelease version:

```text
0.0.0-git.<12-character-commit-hash>
```

The committed manifests intentionally keep the non-publishable placeholder `0.0.0-development`. The `prepublishOnly` check runs the full test suite and rejects placeholder versions or versions whose hash does not match the current commit.

### First publication

npm Trusted Publishing cannot be configured until the package exists. Publish the first build manually from a clean, committed checkout:

```bash
npm login
test -z "$(git status --porcelain)"
version="0.0.0-git.$(git rev-parse --short=12 HEAD)"
npm version "$version" --no-git-tag-version --ignore-scripts
npm publish --tag latest --access public
```

Then configure a GitHub Actions Trusted Publisher in the package settings on npmjs.com:

| Setting | Value |
| --- | --- |
| Organization or user | `githubguy132010` |
| Repository | `pi-customizations` |
| Workflow filename | `publish.yml` |
| Allowed action | `npm publish` |

### Automatic publication

`.github/workflows/publish.yml` tests and publishes every push to `main` as `0.0.0-git.<12-character-commit-hash>`.

The workflow uses GitHub OIDC instead of a stored npm token, publishes provenance, marks each new build as `latest`, and safely skips commits that are already present on npm. It can also be run manually from GitHub Actions.
