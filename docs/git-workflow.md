# Git workflow

This repository is developed on branches and merged through pull requests. `main`
is always green: it passes CI and carries only reviewed, squashed changes.

## Branch model

Trunk-based development with short-lived branches. A branch lives for hours or a
day, never for a week.

| Prefix | Use |
| --- | --- |
| `feat/<slug>` | new behaviour |
| `fix/<slug>` | defect repair |
| `refactor/<slug>` | behaviour-preserving restructuring |
| `docs/<slug>` | documentation only |
| `chore/<slug>` | tooling, CI, repository housekeeping |
| `release/vX.Y.Z` | release preparation |

Rebase the branch on `main` before asking for review, so a squash produces one
readable commit.

## Commits

Conventional Commits, one logical change per commit:

```text
<type>(<scope>): <summary in imperative mood>

Why the change was needed. What the behaviour was, what it is now, and which
mechanism carries it. Mention the tradeoff when the choice is not obvious.

Fixes #12
Refs #14
```

- `type` is one of `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`.
- `scope` is optional: `plugin`, `console`, `scripts`, `skills`, `docs`.
- The body explains the reason, not the diff; the diff already shows the diff.
- Work-in-progress commits are fine on a branch; the squash on merge discards them.

## Pull requests

Every change to `main` arrives through a pull request, including documentation.

1. Branch from `main`, make the change with tests.
2. `scripts/verify.sh` must pass locally; `scripts/install-hooks.sh` wires the same
   gate into `pre-push`.
3. Push the branch and open a pull request with `.github/pull_request_template.md`.
4. CI must be green. The required check is `plugin syntax and tests`.
5. Squash merge. The squashed subject follows the conventional format; the pull
   request body becomes the commit body.
6. Delete the branch.

`main` is protected: no direct pushes, no force pushes, linear history, and the CI
check must pass before merge.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`:

- `node --check` on the extension sources;
- the extension test suite under `superagent-extension`.

The workflow uses Node 26 and installs only the extension's dependencies. Keep CI
under three minutes; a slow job stops being a gate.

## Releases

Functionality and version bumps are separate events.

1. When `main` is worth releasing, open `release/vX.Y.Z` and update
   `superagent-extension/package.json` and `CHANGELOG.md`.
2. Merge that pull request, then tag the merge commit `vX.Y.Z` and publish release
   notes from the changelog section.
3. `CHANGELOG.md` follows Keep a Changelog: `Added`, `Changed`, `Fixed`, `Removed`
   under an `Unreleased` heading, moved under the version at release time.

The version in `superagent-extension/package.json` must equal the tag without the `v`.

## Issues

- Bug and improvement templates live in `.github/ISSUE_TEMPLATE`.
- Every pull request links its issue; a fix closes it through `Fixes #N`.
- Labels: `bug`, `enhancement`, `docs`, `question`, `wontfix`, `blocked`.

## Working with outside contributions

A pull request from another agent or person is reviewed like any other:

1. Read the description and the diff; check whether the behaviour already exists on
   `main`.
2. If it still applies, review it, run its tests together with ours, and merge it.
3. If `main` has moved past it, say which commit supersedes it, port the useful part
   yourself, and close the pull request. Never merge code that predates a refactor
   only to resolve conflicts by hand.
4. Never close a report without stating what addresses it.

## What never goes into git

Case data, run directories, `.case-templates`, credentials, machine paths, model
artefacts and batch results. The `.gitignore` covers them; check `git status`
before staging.
