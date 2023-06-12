# 🤴 Vanity action

A GitHub Action that publishes a Go module's release to
[octolab/vanity](https://github.com/octolab/vanity), the catalog behind the
`go.octolab.org` import paths. The module lives and changes in its own
repository; on a stable release tag its workflow calls this action, which
lists the module's packages at the released commit and writes one entry,
`modules/<module path>.json`, into the catalog in one GitHub-signed commit,
tagged `<name>--vX.Y.Z`. The catalog renders the `go get` and `godoc` pages
from the entries.
<!-- 🤴 Publish Go modules to go.octolab.org through octolab/vanity. -->

## 🚀 Publish from a module

Add a job to the workflow that already runs on the release tag, after the
release job:

```yaml
  # a job of its own: if publishing fails after the release is out, rerun
  # only this job; the catalog keeps stable releases only
  vanity:
    name: Publishing the module
    needs: [ release ]
    if: startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-')
    runs-on: ubuntu-24.04
    permissions:
      contents: read

    steps:
      # without the Releaser credentials (a project generated from a template,
      # a private repository on the Free plan) warn and end successfully
      - name: Check the Releaser credentials
        id: preflight
        env:
          OCTOLAB_RELEASER_CLIENT_ID: ${{ secrets.OCTOLAB_RELEASER_CLIENT_ID }}
          OCTOLAB_RELEASER_KEY: ${{ secrets.OCTOLAB_RELEASER_KEY }}
        run: |
          if [ -n "${OCTOLAB_RELEASER_CLIENT_ID}" ] && [ -n "${OCTOLAB_RELEASER_KEY}" ]; then
            echo 'ready=true' >> "${GITHUB_OUTPUT}"
          else
            echo '::warning title=Vanity::OCTOLAB_RELEASER_CLIENT_ID and OCTOLAB_RELEASER_KEY are not available to this repository; set them as organization or repository secrets to publish the module to go.octolab.org. Nothing was published.'
            echo 'ready=false' >> "${GITHUB_OUTPUT}"
          fi
      - name: Checkout the repository
        if: steps.preflight.outputs.ready == 'true'
        uses: actions/checkout@v7.0.1
        with: { persist-credentials: false }
      - name: Set up Go environment
        if: steps.preflight.outputs.ready == 'true'
        uses: actions/setup-go@v7.0.0
        with: { go-version: 1.27.4, cache: false }
      - name: Mint the catalog token
        if: steps.preflight.outputs.ready == 'true'
        id: catalog
        uses: actions/create-github-app-token@v3.3.0
        with:
          client-id: ${{ secrets.OCTOLAB_RELEASER_CLIENT_ID }}
          private-key: ${{ secrets.OCTOLAB_RELEASER_KEY }}
          owner: octolab
          repositories: vanity
          permission-contents: write
      - name: Publish the module to go.octolab.org
        if: steps.preflight.outputs.ready == 'true'
        uses: octomation/vanity-action@v0.1.0
        with:
          token: ${{ steps.catalog.outputs.token }}
          packages: all
          # name: ecosystem/tablo # when the repository name is taken or doesn't fit
```

A repository without such a workflow gets `.github/workflows/cd.yml` with
the job on its own, and a dispatch to publish a tag again or to try it dry:

```yaml
name: Continuous delivery

on:
  push:
    tags: [ 'v*' ]
  workflow_dispatch:
    inputs:
      tag:
        description: The released tag to publish, e.g. v1.2.3.
        type: string
        required: true
      dry-run:
        description: Check the publication without writing it.
        type: boolean
        default: true

concurrency:
  group: cd-${{ inputs.tag || github.ref_name }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  vanity:
    name: Publishing the module
    if: ${{ startsWith(inputs.tag || github.ref_name, 'v') && !contains(inputs.tag || github.ref_name, '-') }}
    runs-on: ubuntu-24.04

    steps:
      # the credentials check of the job above
      - name: Check the Releaser credentials
        id: preflight
        env:
          OCTOLAB_RELEASER_CLIENT_ID: ${{ secrets.OCTOLAB_RELEASER_CLIENT_ID }}
          OCTOLAB_RELEASER_KEY: ${{ secrets.OCTOLAB_RELEASER_KEY }}
        run: |
          if [ -n "${OCTOLAB_RELEASER_CLIENT_ID}" ] && [ -n "${OCTOLAB_RELEASER_KEY}" ]; then
            echo 'ready=true' >> "${GITHUB_OUTPUT}"
          else
            echo '::warning title=Vanity::OCTOLAB_RELEASER_CLIENT_ID and OCTOLAB_RELEASER_KEY are not available to this repository; set them as organization or repository secrets to publish the module to go.octolab.org. Nothing was published.'
            echo 'ready=false' >> "${GITHUB_OUTPUT}"
          fi
      - name: Checkout the release
        if: steps.preflight.outputs.ready == 'true'
        uses: actions/checkout@v7.0.1
        with:
          ref: refs/tags/${{ inputs.tag || github.ref_name }}
          persist-credentials: false
      - name: Set up Go environment
        if: steps.preflight.outputs.ready == 'true'
        uses: actions/setup-go@v7.0.0
        with: { go-version: 1.27.4, cache: false }
      - name: Mint the catalog token
        if: steps.preflight.outputs.ready == 'true'
        id: catalog
        uses: actions/create-github-app-token@v3.3.0
        with:
          client-id: ${{ secrets.OCTOLAB_RELEASER_CLIENT_ID }}
          private-key: ${{ secrets.OCTOLAB_RELEASER_KEY }}
          owner: octolab
          repositories: vanity
          permission-contents: write
      - name: Publish the module to go.octolab.org
        if: steps.preflight.outputs.ready == 'true'
        uses: octomation/vanity-action@v0.1.0
        with:
          token: ${{ steps.catalog.outputs.token }}
          packages: all
          source-tag: ${{ inputs.tag || github.ref_name }}
          dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
```

The action runs on the runner's own Node.js and needs `go` and `git` on
`PATH`: any Go version works, the module's `go` directive doesn't matter and
nothing is downloaded. Pin the action to a release tag; Dependabot proposes
the next one. Credentials that exist but can't write to the catalog fail the
job loudly.

To publish a tag again, re-run the job, or dispatch a workflow that checks
the tag out and passes it as `source-tag`, as the second example does: on a
branch, `github.ref_name` is the branch name.

| Input | Default | |
|:------|:--------|:--|
| `command` | `publish` | `publish`, or `entry` to print the entry of the checked out module |
| `token` | | token with contents write access to the catalog |
| `name` | repository name | short name in the catalog, kebab-case segments joined by `/` (`indexit`, `ecosystem/tablo`), unique; the catalog tag is `<name>--vX.Y.Z` |
| `packages` | `auto` | `all`, `root`, or `auto`: all in a public repository, root only in a private or internal one |
| `source-tag` | `github.ref_name` | release tag, `vX.Y.Z` |
| `source-sha` | | optional commit the workflow released; must be the checked out commit |
| `catalog-repository` | `octolab/vanity` | catalog to publish to |
| `github-token` | `github.token` | token that reads the module's repository |
| `dry-run` | `false` | decide and log the entry, write nothing |

| Output | |
|:-------|:--|
| `decision` | `publish`, `tag`, `published`, `backport`, `skip` or `entry`: see below |
| `changed` | whether this run wrote a catalog commit |
| `catalog-commit` | catalog commit that holds the release; empty when none |
| `catalog-tag` | catalog tag of the release, `<name>--vX.Y.Z`; empty when none |
| `module` | module path, e.g. `go.octolab.org/toolset/indexit` |
| `name` | short name in the catalog |
| `entry-path` | `modules/<module path>.json` |

The step summary shows the module, the decision, the scope, the package
count and the tag. A publication also logs and summarizes the catalog
with its entry: how many modules publish themselves and which are still
seeds (`version: null`) waiting for their first release.

## 📜 What a module promises

A module on `go.octolab.org` keeps these promises; the action checks the
first three on every release:

1. Its module path is its `go.octolab.org` URL, declared by the `go.mod` at
   the root of its repository; no other project or template declares it.
   v0.1.0 publishes root modules only.
2. A release is an annotated tag `vX.Y.Z` signed by a key of the tagger's
   GitHub account, so GitHub verifies it, on the released commit. Its major
   version follows Go's rule: v0 and v1 for a path without a suffix, vN for
   a path ending in `/vN`. Prereleases `vX.Y.Z-…` are not published: the run
   ends green with a notice.
3. A published release is frozen: its commit, scope and packages never
   change in the catalog. A fix is a new version.
4. Published tags are never deleted or moved, in the module's repository as
   in the catalog (a tag ruleset where the plan allows it).

## ⚙️ What the action does

1. Checks the inputs (exit 2 on a usage error) and that `go` and `git` are
   on `PATH`; a prerelease tag ends here, successfully, as `skip`.
2. Reads the repository's default branch, visibility and topics with
   `github-token`, and requires the release tag to be annotated, signed,
   verified by GitHub and to point at the checked out commit.
3. Lists the packages from a fresh copy of the commit's tracked files, not
   from the working directory: build outputs, untracked or modified files
   don't count, `export-ignore`'d ones do. A directory is a package when it
   holds a Go file some build includes, whatever the runner's GOOS, GOARCH
   or cgo; `testdata`, `vendor`, `_*`, `.*`, symbolic links and nested
   modules are skipped. The module path comes from `go.mod`.
   A module that has nothing to do with the catalog ends here with a
   warning, as `skip`, before the release tag is checked: a module path
   outside `go.octolab.org`, or the module path of the template this
   repository was generated from (GitHub's `template_repository`) while the
   catalog gives it to the template. So a project generated from
   go-module, go-service or go-tool keeps a green release until it declares
   a module of its own; then it publishes like any other.
4. Reads the catalog's `main` and decides, retrying up to five times when
   `main` moves meanwhile:

| State of the catalog | Result |
|:--|:--|
| `<name>--vX.Y.Z` exists with the same release | `published`: success, nothing written |
| `<name>--vX.Y.Z` exists with another release, or off `main` | failure: the release is frozen |
| no entry, a seeded entry (`version: null`), or an older version | `publish`: writes the entry, tags the commit |
| the same version on `main`, its tag missing | `tag`: tags the commit that published it, if GitHub verifies it and `octolab-releaser[bot]` wrote it |
| a newer version on `main`, this one published once, its tag missing | `tag`: the same repair |
| a newer version on `main`, this one never published | `backport`: success, a notice, nothing written |
| the entry belongs to another repository or name | failure: a maintainer moves or renames it |
| the result breaks a catalog rule | failure, naming the rule |

"The same release" is the same name, module, version, source commit, scope
and packages. Branch, visibility and topics are repository metadata: they
change with the repository, never fail a retry, and the next release
refreshes them.

The catalog commit is made with GraphQL `createCommitOnBranch`, so GitHub
signs it as the token's App, `chore(<name>): publish vX.Y.Z`, with the source
commit, module, scope and publisher in its body. The tag is created only
after GitHub reports the commit verified.

## 📄 The entry

`modules/<module path>.json`, canonical bytes: two-space JSON, keys in this
order, ASCII, a final newline (`JSON.stringify(entry, null, 2) + "\n"`):

```json
{
  "schema": 1,
  "name": "indexit",
  "module": "go.octolab.org/toolset/indexit",
  "repository": "https://github.com/octopot/indexit",
  "branch": "main",
  "visibility": "public",
  "scope": "all",
  "packages": [
    "",
    "/cmd/indexit",
    "/internal"
  ],
  "topics": [
    "go",
    "telegram"
  ],
  "version": "v0.4.1",
  "commit": "cbc7add36a6b87e57f0ee412626d91dd2d51d262"
}
```

| Key | Rule |
|:--|:--|
| `schema` | `1` |
| `name` | kebab-case segments joined by `/`: `^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$`, at most 64 characters, unique in the catalog |
| `module` | `go.octolab.org` or a lowercase path under it; the entry's path is `modules/<module>.json` |
| `repository` | `https://github.com/<owner>/<name>`, the repository that publishes it |
| `branch` | the default branch |
| `visibility` | `public`, `private` or `internal` |
| `scope` | `all`, or `root` with `packages` `[""]` |
| `packages` | `""` (the root) first, then `/a/b` paths; unique, sorted by bytes, at most 5000 |
| `topics` | the repository topics, unique, sorted by bytes, at most 20 |
| `version` | `vX.Y.Z`, or `null` for a seeded entry |
| `commit` | the commit the packages were listed from |

The catalog as a whole: every file under `modules/` is a valid entry at its
own path, `go.octolab.org` exists, no package path is listed by two entries,
no entry renders a page over another entry's package (the pages of an entry
are its packages and their parent directories inside the module), no name is
used twice. The action checks all of it on the result before it
writes; octolab/vanity checks it again before it deploys.

A catalog tag `<name>--vX.Y.Z` is always a valid git ref, and the tags of
any two names coexist: no name segment holds `--`, so no tag is a directory
of another (`a--v1.0.0` beside `a/b--v1.0.0`).

A private repository published with `packages: all` makes its package paths
public; `auto` publishes only the root of a private or internal one.

## 🧑‍🔧 Print an entry

```bash
npx --yes github:octomation/vanity-action#v0.1.0 entry --path . \
  [--name NAME] [--packages auto|all|root] [--repository OWNER/NAME] \
  [--branch B] [--visibility V] [--topics a,b] [--commit SHA] [--version vX.Y.Z]
```

prints the canonical entry of the module at `--path`: the root of a git
checkout, listed at `--commit` (HEAD by default), or a plain directory with
`--commit`. Metadata not given on flags comes from the repository with
`GITHUB_TOKEN`; `--repository` defaults to `GITHUB_REPOSITORY`, `--name` to
the repository name, `--version` to `null`. Exit codes: 0 done, 1 refused,
2 usage.

<p align="right">made with ❤️ for everyone by <a href="https://www.octolab.org/">OctoLab</a></p>
