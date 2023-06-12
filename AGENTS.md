# Agent guide

This repository is the publisher of the
[octolab/vanity](https://github.com/octolab/vanity) catalog behind
`go.octolab.org`: the action that a module's release workflow calls to write
its entry, and the `entry` command that prints an entry for maintainers. The
catalog holds only data and renders the pages. Read this before changing
anything.

## Layout

```text
action.yml               node24 action: command publish or entry
scripts/action.mjs       the action's entry point: inputs, outputs, step summary
bin/vanity-action.mjs    the entry command for maintainers (npx)
scripts/cli.mjs          the entry command: flags and repository metadata
scripts/entry.mjs        the entry: canonical bytes, rules, catalog invariants, versions
scripts/go.mjs           git and go: the commit's tree, the module path, the packages
scripts/packages.go      the package lister, run with the runner's go
scripts/github.mjs       REST and GraphQL on fetch
scripts/publish.mjs      the publication through the GitHub API
tests/                   unit and end-to-end tests on a fake GitHub
tests/fixtures/module/   a module with every kind of directory the lister meets
```

No npm dependencies and no build: the runner runs the sources on its own
Node.js 24, so there is no `dist/` to keep in step. Node 22 or later and Go
1.21 or later locally. `scripts/packages.go` imports the standard library
only and runs in GOPATH mode, so it needs no `go.mod`.

The entry format and the catalog invariants are defined twice, here in
`scripts/entry.mjs` and in the catalog's `bin/catalog.py`; a change of one is
a change of both, and must keep reading the entries already published.

## Checks

```sh
npm test
actionlint
```

The tests need `go` and `git` on `PATH`; they run git with no user
configuration and the action against a fake GitHub, in process and over
HTTP. `ci` runs actionlint, the tests and the action itself (`command:
entry` on the fixture) on every push and pull request, and monthly. `cd`
publishes the release of a version tag; see Releasing.

Maintenance runs on schedule: `cleanup.stale` marks and closes inactive
issues and pull requests daily (`status: pending` exempts one), and
`cleanup.runs` deletes completed workflow runs monthly. Every workflow
reports to Slack through `.github/actions/notify` with the organization
secret `SLACK_WEBHOOK`, except `ci` on pull requests; an empty secret skips
the message.

Workflow rules: `permissions: contents: read` at the top, wider only on the
job that needs it; actions pinned to exact patch versions, Node.js and Go
too; `persist-credentials: false` on every checkout; no `${{ }}` inside
`run:`, values reach the shell through `env:`.

## Versions

A release is a signed tag `vX.Y.Z`, never moved or deleted. Consumers pin the
tag and Dependabot proposes the next one, so tag every change that consumers
should get, and only those. No floating major tag: nothing pins it.

The version describes the contract for the workflows that call the action:
its inputs, outputs, the entry it writes and what it accepts. The series
starts at `v0.1.0`: the contract is not stable until it has been proven in
practice, and 1.0.0 is a separate decision.

| Change | Before 1.0 | After 1.0 | Examples |
|:-------|:-----------|:----------|:---------|
| a fix inside; callers change nothing | patch | patch | retry logic, an error message, a dependency bump of a step |
| something new; existing calls work as before | patch | minor | a new optional input or output |
| callers must change their workflow, or a release that passed before is now refused | minor | major | an input renamed, removed or made required, a new token permission, a stricter tag rule, another package list for the same tree |

Before 1.0 this is the OctoLab rule: every `0.Y.*` release is compatible, a
breaking change is the next minor.

## Releasing

Immutable releases are on for the repository: while a published release
exists its tag can't be moved or deleted, and it gets a release attestation
from GitHub. Deleting the release unlocks the tag, but its name can never be
used again; our own rule is stricter: releases and tags stay.

1. `ci` is green on `main`.
2. Write `docs/content/changelog/vX.Y.Z.md`: a heading `# vX.Y.Z — Slogan.`
   and what changes for the workflows that call the action. It becomes the
   release body, and Dependabot quotes it in its pull requests. Commit it.
3. Write the tag annotation to a file outside the repository, following the
   previous tag (`git tag -l --format='%(contents)' vX.Y.W`): the heading,
   one or two sentences, lowercase imperative bullets, and
   `Release notes: docs/content/changelog/vX.Y.Z.md`.
4. Tag and push; `cd` checks the tag (signed and verified by GitHub, on
   `main`, with its note), runs the tests and publishes the release, with
   the note's heading as the title and the rest as the body:

   ```sh
   git tag -s vX.Y.Z -F "$annotation"
   git tag -v vX.Y.Z
   git push origin vX.Y.Z
   ```

   For a tag pushed before `cd` existed, or after it failed:
   `gh workflow run cd.yml -f tag=vX.Y.Z`.
5. `cd` is green: its last step checks that the release is immutable and
   `gh release verify vX.Y.Z` passes.
6. Update the pin in the modules' workflows, or let Dependabot do it.

Until `cd` publishes the release, the tag is not locked: if `cd` fails, fix
the cause and dispatch it again, or delete the tag before anyone pins it.
