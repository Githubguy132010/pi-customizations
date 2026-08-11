# @thatrandomnerd69/pi-coding-agent

An opinionated, standalone Pi coding agent distribution with personal workflow
customizations built in.

## Install

Install the complete CLI from npm:

```bash
npm install --global @thatrandomnerd69/pi-coding-agent
pi-coding-agent
```

This installs the Pi runtime and the customizations together; a separate Pi installation
is not required. The CLI preserves Pi's normal authentication, sessions, settings, modes,
and command-line options.

Check both the distribution build number and bundled upstream Pi version with:

```bash
pi-coding-agent --version
# @thatrandomnerd69/pi-coding-agent build 4f9c2a7d81b3 (Pi 0.84.1)
```

The standalone CLI always loads all five bundled customizations.

## Extensions

| Extension | Behavior |
| --- | --- |
| `extensions/bash-only/index.ts` | Enforces a bash-only tool policy. |
| `extensions/session-workdir/index.ts` | Persists and restores each session's working directory. |
| `extensions/slash-command-visibility/index.ts` | Hides selected built-in commands from slash autocomplete. |
| `extensions/yeet/index.ts` | Adds `/yeet` for AI-assisted commits, pushes, and PR creation. |
| `extensions/settle/index.ts` | Adds `/settle` for merging or closing PRs and cleaning up branches. |

`/yeet` only offers its “create PR + settle” workflow when the settle extension is enabled.
Disabling settle therefore removes both `/settle` and its integration with `/yeet`.

The slash-command visibility extension hides `/name`, `/tree`, `/fork`, `/clone`,
`/compact`, `/trust`, `/export`, `/import`, `/share`, `/hotkeys`, `/changelog`, and
`/llama` from autocomplete. The commands remain executable when entered manually.

Shared implementation modules live in `extensions/shared/`; they are not extension
entrypoints and do not appear as separate toggles.

## Commands

- `/yeet` generates GPT-5.6 Luna commit messages, feature branch names, and PR
  descriptions, with interactive commit/push/PR automation.
- `/settle [PR-number-or-URL]` selects one or more open GitHub PRs, merges or closes
  them, and optionally deletes their local and remote branches. Add `--dry-run` to
  preview each selected plan.

## Development

```bash
npm install
npm run check       # Type-check and run the test suite
npm run test:watch  # Run tests in watch mode
npm run coverage    # Generate text and HTML coverage reports
npm link            # Make pi-coding-agent available globally from this checkout
pi-coding-agent     # Run the linked standalone CLI
```

The tests use Vitest and mocked Pi APIs/command execution, so they do not modify real
repositories, sessions, branches, or pull requests.

## Publishing

npm requires a unique SemVer value for every publication. Builds use the Git commit in
the prerelease component, for example `0.0.0-git.4f9c2a7d81b3`. The committed manifests
keep the non-publishable placeholder `0.0.0-development`; publishing rejects that value
and any hash that does not match the current commit.

### First build

npm Trusted Publishing cannot be configured until the package exists. Publish the first
build manually from a clean, committed checkout:

```bash
npm login
test -z "$(git status --porcelain)"
version="0.0.0-git.$(git rev-parse --short=12 HEAD)"
npm version "$version" --no-git-tag-version --ignore-scripts
npm publish --tag latest --access public
```

The `prepublishOnly` check runs the full test suite and verifies that the version contains
the current commit hash.

### Automatic builds

After the first build exists, open its package settings on npmjs.com and configure a
GitHub Actions Trusted Publisher with these exact values:

- Organization or user: `githubguy132010`
- Repository: `pi-customizations`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The workflow in `.github/workflows/publish.yml` then tests and publishes every push to
`main` as `0.0.0-git.<12-character-commit-hash>`. It uses GitHub OIDC instead of a stored
npm token, marks each new build as `latest`, and safely skips a commit that is already
present on npm. Public source repositories also publish npm provenance; the workflow
omits provenance for private repositories because npm cannot generate a verifiable public
attestation for them. It can also be rerun manually from GitHub Actions.
