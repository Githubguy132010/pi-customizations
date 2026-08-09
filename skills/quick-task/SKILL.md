---
name: quick-task
description: Use this skill to structure and execute small, repeatable tasks quickly and safely.
license: CC0-1.0
---

# Quick Task Skill

## Goal

When asked to do a small coding or tooling task, do the following:

1. Clarify expected outcome in one sentence.
2. Make a minimal plan with 3 steps.
3. Perform the work conservatively, preferring small edits.
4. Validate with a quick check (`npm test`, `npm run lint`, or `go test`) when available.

## Rules

- Avoid changing public interfaces without explicit confirmation.
- Prefer existing conventions in the repository.
- Keep changes focused and easily reviewable.

## Suggested Commands

```bash
rg -n "TODO|FIXME" src
git status --short
```
