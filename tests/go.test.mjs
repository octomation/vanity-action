import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { entryCommand } from '../scripts/cli.mjs'
import { format, localModule } from '../scripts/entry.mjs'
import { FIXTURE, FIXTURE_PACKAGES, MODULE, git, makeRepo } from './fake.mjs'

const BIN = fileURLToPath(new URL('../bin/vanity-action.mjs', import.meta.url))
const repo = makeRepo()

test('lists the packages of the commit whatever the build target', () => {
  // the checkout has untracked, ignored and modified files; the commit has an
  // export-ignore'd package: the list comes from the commit as it is
  const m = localModule(repo.dir, { scope: 'all' })
  assert.equal(m.module, MODULE)
  assert.equal(m.commit, repo.sha)
  assert.deepEqual(m.packages, FIXTURE_PACKAGES)
})

test('scope root lists the root package only', () => {
  assert.deepEqual(localModule(repo.dir, { scope: 'root' }).packages, [''])
})

test('a go directive newer than the runner, an empty cache and no network do not matter', () => {
  const env = { GOMODCACHE: process.env.GOMODCACHE, GOPROXY: process.env.GOPROXY }
  process.env.GOMODCACHE = mkdtempSync(join(tmpdir(), 'vanity-action-cache-'))
  process.env.GOPROXY = 'https://invalid.example'
  try {
    assert.equal(localModule(repo.dir, { scope: 'all' }).module, MODULE)
  } finally {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

test('only a module at the repository root is published', () => {
  // go.mod in a subdirectory, nothing at the root
  const nested = makeRepo({
    edit: (dir) => {
      mkdirSync(join(dir, 'sub'))
      renameSync(join(dir, 'go.mod'), join(dir, 'sub', 'go.mod'))
    },
  })
  assert.throws(() => localModule(nested.dir, { scope: 'all' }), /no go\.mod at the repository root/)
  // a directory inside the checkout
  assert.throws(() => localModule(join(nested.dir, 'sub'), { scope: 'all' }), /not the root of its repository/)
})

test('a plain directory is listed as it is and needs a commit', () => {
  const plain = mkdtempSync(join(tmpdir(), 'vanity-action-plain-'))
  cpSync(FIXTURE, plain, { recursive: true })
  assert.throws(() => localModule(plain, { scope: 'all' }), /pass --commit/)
  const m = localModule(plain, { scope: 'all', commit: 'e'.repeat(40) })
  assert.deepEqual(m.packages, FIXTURE_PACKAGES)
  assert.equal(m.commit, 'e'.repeat(40))
  rmSync(plain, { recursive: true })
})

test('entry builds the canonical entry from flags without the API', async () => {
  const e = await entryCommand(
    { path: repo.dir, repository: 'octopot/fixture', branch: 'main', visibility: 'private', topics: 'go,cli', packages: 'all', version: 'v1.2.3' },
    { env: {}, rest: () => assert.fail('no API call expected') },
  )
  assert.equal(e.name, 'fixture')
  assert.deepEqual(e.topics, ['cli', 'go'])
  assert.equal(e.scope, 'all')
  assert.equal(e.version, 'v1.2.3')
  assert.equal(e.commit, repo.sha)
  const auto = await entryCommand(
    { path: repo.dir, repository: 'octopot/fixture', name: 'fx', branch: 'main', visibility: 'private', topics: '' },
    { env: {}, rest: () => assert.fail('no API call expected') },
  )
  assert.equal(auto.name, 'fx')
  assert.deepEqual(auto.packages, [''])
  assert.equal(auto.version, null)
})

test('entry reads missing metadata from the repository', async () => {
  const calls = []
  const rest = async (method, path) => {
    calls.push(`${method} ${path}`)
    return { full_name: 'octopot/fixture', default_branch: 'trunk', visibility: 'public', topics: ['z', 'a'] }
  }
  const e = await entryCommand({ path: repo.dir, repository: 'octopot/fixture' }, { env: {}, rest })
  assert.deepEqual(calls, ['GET /repos/octopot/fixture'])
  assert.equal(e.branch, 'trunk')
  assert.deepEqual(e.topics, ['a', 'z'])
  assert.equal(e.scope, 'all')
  await assert.rejects(entryCommand({ path: repo.dir, repository: 'octopot/Fix_ture', branch: 'm', visibility: 'public', topics: '' }, { env: {} }), /set the name input/)
  await assert.rejects(entryCommand({ path: repo.dir, repository: 'octopot/fixture', branch: 'm', visibility: 'public', topics: '', version: 'v2.0.0' }, { env: {} }), /\/v2/)
})

test('the CLI prints the entry and exits 2 on usage errors', () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '' } })
  const ok = run('entry', '--path', repo.dir, '--repository', 'octopot/fixture', '--branch', 'main', '--visibility', 'public', '--topics', 'go', '--commit', repo.sha, '--packages', 'all')
  assert.equal(ok.status, 0, ok.stderr)
  const e = JSON.parse(ok.stdout)
  assert.equal(ok.stdout, format(e))
  assert.deepEqual(e.packages, FIXTURE_PACKAGES)
  assert.equal(run('publish').status, 2)
  assert.equal(run('entry', '--bogus', 'x').status, 2)
  assert.equal(run('entry', '--path', repo.dir).status, 2) // no repository
  const bad = run('entry', '--path', repo.dir, '--repository', 'octopot/fixture', '--branch', 'main', '--visibility', 'public', '--topics', '', '--commit', 'f'.repeat(40))
  assert.equal(bad.status, 1)
})

test('symbolic links are skipped, a package clause error still lists the directory', () => {
  const r = makeRepo({
    edit: (dir) => {
      writeFileSync(join(dir, 'internal', 'broken', 'c.go'), 'package other\n')
      mkdirSync(join(dir, 'internal', 'link'))
      symlinkSync('../../fixture.go', join(dir, 'internal', 'link', 'l.go'))
      symlinkSync('../cmd', join(dir, 'internal', 'cmdlink'))
    },
  })
  const packages = localModule(r.dir, { scope: 'all' }).packages
  assert.ok(packages.includes('/internal/broken'))
  assert.ok(!packages.includes('/internal/link'))
  assert.ok(!packages.some((p) => p.startsWith('/internal/cmdlink')))
  assert.equal(git(r.dir, 'status', '--porcelain', '--', 'internal/broken'), '')
})

test('checkout filters of the caller configuration do not change what is listed', () => {
  const r = makeRepo({
    edit: (dir) => writeFileSync(join(dir, '.gitattributes'), '*.go filter=evil\ngo.mod filter=evil\n'),
  })
  git(r.dir, 'config', 'filter.evil.smudge', 'sed -e s/fixture/evil/ -e s/package/broken/')
  git(r.dir, 'config', 'filter.evil.required', 'true')
  const m = localModule(r.dir, { scope: 'all' })
  assert.equal(m.module, MODULE)
  assert.deepEqual(m.packages, FIXTURE_PACKAGES)
})
