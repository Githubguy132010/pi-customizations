# Changelog

This file records user-facing changes to `@thatrandomnerd69/pi-coding-agent`.

The project publishes commit-addressed versions in the form
`0.0.0-git.<commit-hash>`, so entries are grouped by date instead of version.

## Unreleased

## 2026-08-20

### Added

- Added an experimental `ephemeral_agent` tool for running short-lived sub-agents
  in isolated repository clones. Set `PI_EXPERIMENTAL=1` when starting the CLI to
  enable it.

### Changed

- Updated the bundled Pi runtime and TUI from 0.84.1 to 0.84.2.
- Added automated handling for tested Pi patch updates. Minor and major updates
  still require manual review.

### Fixed

- Hardened ephemeral-agent startup, messaging, follow-ups, cancellation, waiting,
  and cleanup against timing races and timeouts.
- Preserved final results after an ephemeral agent settles.
- Applied backpressure to ephemeral-agent message queues.

## 2026-08-11

### Changed

- Renamed `/land` to `/settle` and updated its integration with `/yeet`.
- Switched npm publishing to GitHub Actions trusted publishing with provenance.

## 2026-08-10

### Added

- Packaged the customizations as the standalone
  `@thatrandomnerd69/pi-coding-agent` CLI. A separate Pi installation is no
  longer required.
- Added commit-addressed npm versions and checks that prevent publishing a build
  from the wrong commit.

## 2026-08-09

### Added

- Started the project with a bash-only tool policy.
- Added session working-directory persistence.
- Added `/yeet` for generating commit messages, feature branch names, and pull
  request descriptions, with interactive commit, push, and PR creation steps.
- Added the pull-request workflow now called `/settle`, including multi-PR
  selection, merge and close actions, branch cleanup, and dry-run previews.
- Added a slash-command visibility extension that hides selected built-in
  commands from autocomplete without disabling them.

### Changed

- Split the original combined customization into independent extensions with
  shared implementation modules.
