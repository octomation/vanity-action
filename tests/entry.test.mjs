import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildEntry,
  catalogProgress,
  catalogTag,
  checkCatalog,
  checkEntry,
  compareStable,
  entryPath,
  format,
  identity,
  majorProblem,
  parseEntry,
  parseVersion,
  rendered,
  resolveScope,
} from '../scripts/entry.mjs'
import { encodePath } from '../scripts/github.mjs'
import { ROOT_ENTRY, entry } from './fake.mjs'

const files = (...entries) => new Map(entries.map((e) => [entryPath(e.module), Buffer.from(format(e))]))

test('the canonical bytes are two-space JSON with keys in order and a final newline', () => {
  const e = entry({ version: 'v1.0.0' })
  const shuffled = Object.fromEntries(Object.entries(e).reverse())
  const text = format(shuffled)
  assert.equal(text, JSON.stringify(e, null, 2) + '\n')
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'schema', 'name', 'module', 'repository', 'branch', 'visibility', 'scope', 'packages', 'topics', 'version', 'commit',
  ])
  assert.match(text, /\n {2}"packages": \[\n {4}"",\n {4}"\/cmd\/tool",/)
  assert.deepEqual(parseEntry(text, entryPath(e.module)).errors, [])
})

test('parseEntry refuses non-canonical, non-ASCII and misplaced entries', () => {
  const e = entry()
  assert.match(parseEntry(JSON.stringify(e), entryPath(e.module)).errors[0], /canonical/)
  assert.match(parseEntry(format({ ...e, topics: ['gö'] }), entryPath(e.module)).errors[0], /ASCII/)
  assert.match(parseEntry(format(e), 'modules/go.octolab.org/other.json').errors[0], /belongs at modules\/go\.octolab\.org\/toolset\/fixture\.json/)
  assert.match(parseEntry('{', 'modules/x.json').errors[0], /JSON/)
})

test('checkEntry enforces every rule of the entry', () => {
  const bad = (fields, re) => assert.ok(checkEntry(entry(fields)).some((m) => re.test(m)), `${JSON.stringify(fields)} should fail ${re}`)
  assert.deepEqual(checkEntry(entry()), [])
  assert.deepEqual(checkEntry(ROOT_ENTRY), [])
  bad({ schema: 2 }, /schema/)
  bad({ name: 'Fixture' }, /name/)
  bad({ name: 'a--b' }, /name/)
  bad({ name: 'x'.repeat(65) }, /name/)
  bad({ module: 'github.com/x/y' }, /module/)
  bad({ module: 'go.octolab.org/a/../b' }, /module/)
  bad({ module: 'go.octolab.org/A' }, /module/)
  bad({ repository: 'https://github.com/x/y.git' }, /repository/)
  bad({ repository: 'http://github.com/x/y' }, /repository/)
  bad({ branch: '-x' }, /branch/)
  bad({ branch: 'a..b' }, /branch/)
  bad({ visibility: 'secret' }, /visibility/)
  bad({ scope: 'some' }, /scope/)
  bad({ scope: 'root' }, /root package only/)
  bad({ packages: ['/a'] }, /start with ""/)
  bad({ packages: ['', '/b', '/a'] }, /sorted/)
  bad({ packages: ['', '/a', '/a'] }, /unique/)
  for (const p of ['/a/testdata', '/vendor/x', '/.x', '/_x', '/a/..', 'a', '/a b']) bad({ packages: ['', p] }, /invalid packages/)
  bad({ packages: ['', ...Array.from({ length: 5000 }, (_, i) => `/p${String(i).padStart(4, '0')}`)] }, /at most 5000/)
  bad({ topics: ['b', 'a'] }, /sorted/)
  bad({ topics: ['A'] }, /invalid topics/)
  bad({ topics: Array.from({ length: 21 }, (_, i) => `t${String(i).padStart(2, '0')}`) }, /at most 20/)
  bad({ version: 'v1.0.0-rc1' }, /version/)
  bad({ version: '1.0.0' }, /version/)
  bad({ version: 'v2.0.0' }, /\/v2/)
  bad({ commit: 'abc' }, /commit/)
  bad({ module: 'go.octolab.org/x/v1.2' }, /v2 or higher/)
  bad({ module: 'go.octolab.org/x/v1' }, /v2 or higher/)
  const extra = { ...entry(), extra: 1 }
  assert.match(checkEntry(extra)[0], /keys must be exactly/)
})

test('buildEntry sorts and dedupes topics and fails with every problem', () => {
  const e = buildEntry({ ...entry({ topics: ['go', 'cli', 'go'] }) })
  assert.deepEqual(e.topics, ['cli', 'go'])
  assert.throws(() => buildEntry({ ...entry({ scope: 'root' }) }), /root package only/)
})

test('versions: semver with a v, stable ordering, Go major version rule', () => {
  assert.deepEqual(parseVersion('v1.2.3-rc.1'), { major: 1n, minor: 2n, patch: 3n, pre: ['rc', '1'] })
  // past Number.MAX_SAFE_INTEGER
  assert.equal(compareStable('v1.0.9007199254740993', 'v1.0.9007199254740992'), 1)
  assert.match(majorProblem('go.octolab.org/x/v9007199254740992', 'v9007199254740993.0.0'), /does not match/)
  for (const v of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3+meta', 'v1.2.3-']) assert.equal(parseVersion(v), null, v)
  assert.equal(compareStable('v1.10.0', 'v1.9.9'), 1)
  assert.equal(compareStable('v1.0.0', 'v1.0.0'), 0)
  assert.equal(compareStable('v0.9.0', 'v1.0.0'), -1)
  assert.equal(majorProblem('go.octolab.org/x', 'v0.1.0'), null)
  assert.equal(majorProblem('go.octolab.org/x', 'v1.9.0'), null)
  assert.match(majorProblem('go.octolab.org/x', 'v2.0.0'), /go\.octolab\.org\/x\/v2/)
  assert.equal(majorProblem('go.octolab.org/x/v2', 'v2.3.0'), null)
  assert.match(majorProblem('go.octolab.org/x/v2', 'v1.0.0'), /v2\.x\.y/)
  assert.match(majorProblem('go.octolab.org/x/v3', 'v2.0.0'), /v3\.x\.y/)
  assert.match(majorProblem('go.octolab.org/x/v1', 'v1.0.0'), /v2 or higher/)
  assert.match(majorProblem('go.octolab.org/x/v02', 'v2.0.0'), /v2 or higher/)
  assert.match(majorProblem('go.octolab.org/x/v1.2', 'v1.0.0'), /v2 or higher/)
  assert.match(majorProblem('go.octolab.org/x/v2.0', 'v2.0.0'), /v2 or higher/)
  assert.equal(majorProblem('go.octolab.org/x/v2x', 'v1.0.0'), null)
})

test('catalog invariants S1-S4', () => {
  const fixture = entry()
  assert.deepEqual(checkCatalog(files(ROOT_ENTRY, fixture)), [])
  // S1: a non-entry file and a broken entry
  const s1 = files(ROOT_ENTRY)
  s1.set('modules/README.md', Buffer.from('x'))
  s1.set(entryPath(fixture.module), Buffer.from('{}'))
  const e1 = checkCatalog(s1)
  assert.ok(e1.some((m) => /modules\/README\.md: only entries/.test(m)))
  assert.ok(e1.some((m) => /fixture\.json: keys must be exactly/.test(m)))
  // S2: no root module
  assert.match(checkCatalog(files(fixture)).join(), /root module is missing/)
  // S3: a package of two entries
  const clash = entry({ module: 'go.octolab.org/toolset', name: 'toolset', packages: ['', '/fixture'] })
  assert.match(checkCatalog(files(ROOT_ENTRY, fixture, clash)).join(), /go\.octolab\.org\/toolset\/fixture is listed by both/)
  // S4: a name of two entries
  const twin = entry({ module: 'go.octolab.org/ecosystem/fixture', packages: [''] })
  assert.match(checkCatalog(files(ROOT_ENTRY, fixture, twin)).join(), /name fixture is taken/)
})

test('identity leaves out the repository metadata', () => {
  const e = entry({ version: 'v1.0.0' })
  assert.equal(identity(e), identity({ ...e, branch: 'dev', visibility: 'private', topics: ['x'], repository: 'https://github.com/a/b' }))
  for (const k of ['name', 'module', 'version', 'commit', 'scope']) assert.notEqual(identity(e), identity({ ...e, [k]: 'x' }), k)
  assert.notEqual(identity(e), identity({ ...e, packages: [''] }))
})

test('scope, tags and paths', () => {
  assert.equal(resolveScope('auto', 'public'), 'all')
  assert.equal(resolveScope('auto', 'private'), 'root')
  assert.equal(resolveScope('auto', 'internal'), 'root')
  assert.equal(resolveScope('all', 'private'), 'all')
  assert.equal(resolveScope('root', 'public'), 'root')
  assert.throws(() => resolveScope('some', 'public'), /auto, all or root/)
  assert.equal(catalogTag('indexit', 'v0.4.1'), 'indexit--v0.4.1')
  assert.equal(entryPath('go.octolab.org'), 'modules/go.octolab.org.json')
  assert.equal(encodePath('modules/go.octolab.org/a b.json'), 'modules/go.octolab.org/a%20b.json')
})

test('names: kebab-case segments joined by /, valid git refs that coexist', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  for (const name of ['indexit', 'go-module', 'ecosystem/tablo', 'a/b-c/d1']) assert.deepEqual(checkEntry(entry({ name })), [], name)
  for (const name of ['a//b', '/a', 'a/', 'A/b', 'a--b', 'a/-b', 'a/b-', 'a.b', 'a_b', `a/${'b'.repeat(63)}`]) {
    assert.ok(checkEntry(entry({ name })).some((m) => /name must be/.test(m)), name)
  }
  // the tags of a, a/b and a/b/c are valid refs and live side by side
  const dir = mkdtempSync(join(tmpdir(), 'vanity-action-refs-'))
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } })
  run('init', '-q')
  run('commit', '-q', '--allow-empty', '-m', 'x')
  const tags = ['a', 'a/b', 'a/b/c', 'ecosystem/tablo', 'ecosystem'].map((n) => catalogTag(n, 'v1.2.3'))
  for (const t of tags) {
    run('check-ref-format', `refs/tags/${t}`)
    run('tag', t)
  }
  assert.deepEqual(run('tag', '--list').trim().split('\n').sort(), [...tags].sort())
})

test('S5: an entry may not render a parent page over another entry\'s package', () => {
  // go.octolab.org/toolset publishes /fixture as a package; the fixture
  // module renders go.octolab.org/toolset/fixture as its root page
  const parent = entry({ module: 'go.octolab.org/toolset', name: 'toolset', packages: ['', '/fixture'] })
  const child = entry({ packages: [''] })
  assert.match(checkCatalog(files(ROOT_ENTRY, parent, child)).join(), /renders go\.octolab\.org\/toolset\/fixture, which go\.octolab\.org\/toolset publishes/)
  // a parent directory of a package, not a package itself
  const deep = entry({ module: 'go.octolab.org/x', name: 'x', packages: ['', '/a/b'] })
  const owner = entry({ module: 'go.octolab.org/x/a', name: 'xa', packages: [''] })
  assert.match(checkCatalog(files(ROOT_ENTRY, deep, owner)).join(), /go\.octolab\.org\/x renders go\.octolab\.org\/x\/a, which go\.octolab\.org\/x\/a publishes/)
  // the root module renders only its own pages
  assert.deepEqual(checkCatalog(files(ROOT_ENTRY, entry())), [])
  assert.deepEqual([...rendered(deep)].sort(), ['go.octolab.org/x', 'go.octolab.org/x/a', 'go.octolab.org/x/a/b'])
})

test('catalogProgress counts the self-published modules and names the seeds', () => {
  const fixture = entry()
  const seeded = catalogProgress(files(ROOT_ENTRY, fixture))
  assert.deepEqual(seeded, { published: 0, total: 2, seeds: ['fixture', 'pkg'], text: 'Self-published: 0 of 2 modules; on seeds: 2 (fixture, pkg)' })
  const all = catalogProgress(files({ ...ROOT_ENTRY, version: 'v0.12.2' }, { ...fixture, version: 'v1.0.0' }))
  assert.equal(all.text, 'Self-published: 2 of 2 modules; on seeds: 0')
})
