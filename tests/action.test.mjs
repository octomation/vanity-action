// End to end: the action's entry point as the runner starts it, with real git
// and go, against the fake GitHub served over HTTP.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { escape } from '../scripts/action.mjs'
import { format } from '../scripts/entry.mjs'
import { CATALOG, FIXTURE_PACKAGES, FakeGitHub, MODULE, SOURCE, entry, makeRepo } from './fake.mjs'

const ACTION = fileURLToPath(new URL('../scripts/action.mjs', import.meta.url))
const repo = makeRepo()
let gh
let api

before(async () => {
  gh = new FakeGitHub()
  api = await gh.listen()
})
after(() => gh.close())

// action runs scripts/action.mjs with the inputs and the runner's variables.
// spawn, not spawnSync: the fake server runs in this process.
function action(inputs, { workspace = repo.dir, env = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'vanity-action-run-'))
  const files = { GITHUB_OUTPUT: join(tmp, 'output'), GITHUB_STEP_SUMMARY: join(tmp, 'summary') }
  for (const f of Object.values(files)) writeFileSync(f, '')
  const vars = {
    ...process.env,
    ...files,
    GITHUB_API_URL: api,
    GITHUB_GRAPHQL_URL: `${api}/graphql`,
    GITHUB_REPOSITORY: SOURCE,
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_REPOSITORY: 'octomation/vanity-action',
    GITHUB_ACTION_REF: 'v0.1.0',
    RUNNER_TEMP: tmp,
    'INPUT_SOURCE-TAG': 'v1.0.0',
    'INPUT_CATALOG-REPOSITORY': CATALOG,
    'INPUT_GITHUB-TOKEN': 'source-token',
    INPUT_PACKAGES: 'auto',
    'INPUT_DRY-RUN': 'false',
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    ...env,
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACTION], { cwd: workspace, env: vars })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => {
      const outputs = Object.fromEntries(
        readFileSync(files.GITHUB_OUTPUT, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
      resolve({ status, stdout, stderr, outputs, summary: readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8') })
    })
  })
}

test('end to end: dry run, publish, retry, frozen conflict', async () => {
  gh.tagRelease('v1.0.0', repo.sha)

  const dry = await action({ token: 'catalog-token', 'dry-run': 'true' })
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  assert.equal(dry.outputs.decision, 'publish')
  assert.equal(dry.outputs.changed, 'false')
  assert.equal(gh.calls.graphql, 0)
  assert.match(dry.summary, /\| publish \(dry run\) \| all \| 12 \|/)
  assert.match(dry.summary, /^Self-published: 1 of 2 modules; on seeds: 1 \(pkg\) \(with this release\)$/m)

  const first = await action({ token: 'catalog-token' })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.deepEqual(first.outputs, {
    decision: 'publish',
    changed: 'true',
    'catalog-commit': gh.head().oid,
    'catalog-tag': 'fixture--v1.0.0',
    module: MODULE,
    name: 'fixture',
    'entry-path': `modules/${MODULE}.json`,
  })
  assert.equal(gh.head().files[`modules/${MODULE}.json`], format(entry({ version: 'v1.0.0', commit: repo.sha })))
  assert.match(gh.head().message, /Publisher: octomation\/vanity-action@v0\.1\.0/)
  assert.deepEqual(JSON.parse(gh.head().files[`modules/${MODULE}.json`]).packages, FIXTURE_PACKAGES)

  const again = await action({ token: 'catalog-token' })
  assert.equal(again.status, 0, again.stdout)
  assert.equal(again.outputs.decision, 'published')
  assert.equal(again.outputs.changed, 'false')
  assert.equal(gh.calls.graphql, 1)

  const moved = makeRepo({ edit: (dir) => writeFileSync(join(dir, 'moved.go'), 'package fixture\n') })
  gh.tagRelease('v1.0.0', moved.sha)
  const frozen = await action({ token: 'catalog-token' }, { workspace: moved.dir })
  assert.equal(frozen.status, 1)
  assert.match(frozen.stdout, /::error::fixture--v1\.0\.0 already exists/)
  gh.tagRelease('v1.0.0', repo.sha)
})

test('end to end: prerelease skip, usage and refusals', async () => {
  const pre = await action({ token: 'catalog-token', 'source-tag': 'v2.0.0-rc.1' })
  assert.equal(pre.status, 0)
  assert.match(pre.stdout, /::notice::v2\.0\.0-rc\.1 is a prerelease/)
  assert.equal(pre.outputs.decision, 'skip')

  assert.equal((await action({})).status, 2) // no token
  assert.equal((await action({ token: 't', command: 'check' })).status, 2)
  assert.equal((await action({ token: 't', 'dry-run': 'yes' })).status, 2)
  assert.equal((await action({ token: 't', packages: 'some' })).status, 2)

  const nested = makeRepo({
    edit: (dir) => {
      mkdirSync(join(dir, 'sub'))
      renameSync(join(dir, 'go.mod'), join(dir, 'sub', 'go.mod'))
    },
  })
  gh.tagRelease('v1.0.1', nested.sha)
  const nonRoot = await action({ token: 't', 'source-tag': 'v1.0.1' }, { workspace: nested.dir })
  assert.equal(nonRoot.status, 1)
  assert.match(nonRoot.stdout, /::error::no go\.mod at the repository root/)

  const major = await action({ token: 't', 'source-tag': 'v2.0.0' })
  assert.equal(major.status, 1)

  const noGo = await action({ token: 't' }, { env: { PATH: '/nonexistent' } })
  assert.equal(noGo.status, 2)
  assert.match(noGo.stdout, /not on PATH/)

  const unknown = await action({ token: 't', 'catalog-repository': 'octolab/other' })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stdout, /::error::octolab\/other: no main branch/)
  // a message with newlines stays on one workflow command line
  assert.equal(escape('a\n::warning::b%\r'), 'a%0A::warning::b%25%0D')
})

test('end to end: command entry prints the entry of the workspace', async () => {
  const res = await action({ command: 'entry', packages: 'all', name: 'fx' })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  const e = JSON.parse(res.stdout.slice(0, res.stdout.lastIndexOf('}\n') + 2))
  assert.equal(e.name, 'fx')
  assert.equal(e.version, null)
  assert.equal(e.commit, repo.sha)
  assert.deepEqual(e.packages, FIXTURE_PACKAGES)
  assert.equal(res.outputs['entry-path'], `modules/${MODULE}.json`)
})
