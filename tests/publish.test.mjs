import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { format } from '../scripts/entry.mjs'
import { publish } from '../scripts/publish.mjs'
import { CATALOG, FIXTURE_PACKAGES, FakeGitHub, MODULE, RELEASER, ROOT_ENTRY, SOURCE, entry, git, makeRepo } from './fake.mjs'

const repo = makeRepo()
const PATH = `modules/${MODULE}.json`

// setup returns a fake GitHub whose source repository tags `tag` at the
// checkout, and the options of a publication of it.
function setup({ tag = 'v1.0.0', metadata, entries, dir = repo.dir, sha = repo.sha, ...opts } = {}) {
  const gh = new FakeGitHub({ metadata, entries })
  gh.tagRelease(tag, sha)
  const options = { workspace: dir, sourceTag: tag, callerRepository: SOURCE, catalog: CATALOG, packages: 'auto', publisher: 'octomation/vanity-action@v0.1.0', ...opts }
  const run = (more = {}) => publish({ ...options, ...more }, gh.clients())
  return { gh, run, options }
}

test('first publication writes the entry in one commit and tags it', async () => {
  const { gh, run } = setup()
  const out = await run()
  assert.equal(out.decision, 'publish')
  assert.equal(out.changed, true)
  assert.equal(out['catalog-tag'], 'fixture--v1.0.0')
  assert.equal(out['catalog-commit'], gh.head().oid)
  assert.equal(out['entry-path'], PATH)
  assert.equal(out.module, MODULE)
  assert.equal(gh.tags['fixture--v1.0.0'], gh.head().oid)
  const written = gh.head().files[PATH]
  assert.equal(written, format(entry({ version: 'v1.0.0', commit: repo.sha })))
  assert.equal(gh.head().files['modules/go.octolab.org.json'], format(ROOT_ENTRY))
  assert.equal(
    gh.head().message,
    `chore(fixture): publish v1.0.0\n\nSource: ${SOURCE}@${repo.sha} (v1.0.0)\nModule: ${MODULE}\nScope: all (${FIXTURE_PACKAGES.length} packages)\nPublisher: octomation/vanity-action@v0.1.0`,
  )
  assert.equal(gh.calls.graphql, 1)
})

test('a seeded entry gets its first version', async () => {
  const { gh, run } = setup({ entries: [ROOT_ENTRY, entry({ topics: ['old'] })] })
  const out = await run()
  assert.equal(out.decision, 'publish')
  // the release displaces its seed: the progress counts the catalog with it
  assert.equal(out.progress, 'Self-published: 1 of 2 modules; on seeds: 1 (pkg)')
  const e = gh.entryAt('main')
  assert.equal(e.version, 'v1.0.0')
  assert.deepEqual(e.topics, ['go'])
})

test('a retry of a published release is a no-op', async () => {
  const { gh, run } = setup()
  await run()
  const out = await run()
  assert.equal(out.decision, 'published')
  assert.equal(out.progress, undefined)
  assert.equal(out.changed, false)
  assert.equal(out['catalog-tag'], 'fixture--v1.0.0')
  assert.equal(gh.calls.graphql, 1)
})

test('changed repository metadata never fails a retry', async () => {
  const { gh, run } = setup()
  await run()
  gh.metadata = { ...gh.metadata, default_branch: 'trunk', topics: ['zz', 'aa'], visibility: 'public' }
  assert.equal((await run()).decision, 'published')
  // and with the tag lost too: the publication is tagged, nothing rewritten
  const published = gh.tags['fixture--v1.0.0']
  delete gh.tags['fixture--v1.0.0']
  const out = await run()
  assert.equal(out.decision, 'tag')
  assert.equal(gh.tags['fixture--v1.0.0'], published)
  assert.equal(gh.calls.graphql, 1)
})

test('a published release is frozen', async () => {
  const { gh, run } = setup()
  await run()
  // the same tag moved to another commit
  const other = makeRepo({ edit: (dir) => mkdirSync(join(dir, 'extra')) })
  git(other.dir, 'commit', '-q', '--allow-empty', '-m', 'moved')
  const moved = git(other.dir, 'rev-parse', 'HEAD')
  gh.tagRelease('v1.0.0', moved)
  await assert.rejects(run({ workspace: other.dir }), /fixture--v1\.0\.0 already exists .* a published release is frozen/)
  // and without the tag: the version on main is frozen too
  delete gh.tags['fixture--v1.0.0']
  await assert.rejects(run({ workspace: other.dir }), /v1\.0\.0 was published on .* a published release is frozen/)
  // scope is part of the release too
  gh.tagRelease('v1.0.0', repo.sha)
  await assert.rejects(run({ packages: 'root' }), /frozen/)
  assert.equal(gh.calls.graphql, 1)
})

test('main moving under the run is retried', async () => {
  const { gh, run } = setup()
  let moves = 1
  gh.beforeCommit = () => {
    if (moves-- > 0) gh.pushEntry({ ...ROOT_ENTRY, topics: ['moved'] }, 'another publication')
  }
  const out = await run()
  assert.equal(out.decision, 'publish')
  assert.equal(gh.calls.graphql, 2)
  assert.deepEqual(JSON.parse(gh.head().files['modules/go.octolab.org.json']).topics, ['moved'])
  assert.equal(gh.entryAt('main').version, 'v1.0.0')
})

test('main that keeps moving fails after five attempts', async () => {
  const { gh, run } = setup()
  gh.beforeCommit = () => gh.pushEntry({ ...ROOT_ENTRY, topics: [`t${gh.commits.length}`] })
  await assert.rejects(run(), /kept moving; 5 attempts/)
  assert.equal(gh.calls.graphql, 5)
})

test('a concurrent run of the same release wins the race', async () => {
  const { gh, run } = setup()
  // the other run commits first; this one then sees the version on main
  gh.beforeCommit = () => {
    gh.beforeCommit = null
    const oid = gh.pushEntry(entry({ version: 'v1.0.0', commit: repo.sha }), 'chore(fixture): publish v1.0.0', RELEASER)
    gh.tags['fixture--v1.0.0'] = oid
  }
  const out = await run()
  assert.equal(out.decision, 'published')
  assert.equal(gh.calls.graphql, 1)
})

test('the tag created concurrently for the same publication is accepted', async () => {
  const { gh, run } = setup()
  gh.beforeTag = () => {
    gh.tags['fixture--v1.0.0'] = gh.head().oid
  }
  const out = await run()
  assert.equal(out.changed, true)
  assert.equal(out['catalog-commit'], gh.head().oid)
})

test('an older release: a backport is a no-op, a lost tag is repaired', async () => {
  const older = makeRepo({ edit: (dir) => mkdirSync(join(dir, 'older')) })
  git(older.dir, 'commit', '-q', '--allow-empty', '-m', 'older')
  const olderSha = git(older.dir, 'rev-parse', 'HEAD')
  const { gh, run } = setup({ tag: 'v1.1.0' })
  gh.tagRelease('v1.0.0', olderSha)
  await run()
  // v1.0.0 never reached the catalog: nothing to do, no tag
  const backport = await run({ workspace: older.dir, sourceTag: 'v1.0.0' })
  assert.equal(backport.decision, 'backport')
  assert.equal(backport.changed, false)
  assert.equal(gh.tags['fixture--v1.0.0'], undefined)
  assert.equal(gh.calls.graphql, 1)

  // v1.0.0 published, its tag lost, then v1.1.0: the retry of v1.0.0 tags
  // its publication commit
  const g2 = setup({ tag: 'v1.0.0', dir: older.dir, sha: olderSha })
  g2.gh.tagRelease('v1.1.0', repo.sha)
  await g2.run()
  const first = g2.gh.tags['fixture--v1.0.0']
  delete g2.gh.tags['fixture--v1.0.0']
  await g2.run({ workspace: repo.dir, sourceTag: 'v1.1.0' })
  g2.gh.pushEntry({ ...ROOT_ENTRY, topics: ['later'] })
  const repaired = await g2.run()
  assert.equal(repaired.decision, 'tag')
  assert.equal(g2.gh.tags['fixture--v1.0.0'], first)
  assert.equal(repaired['catalog-commit'], first)
})

test('the version on main without its tag is tagged on its publication commit', async () => {
  const { gh, run } = setup()
  await run()
  const published = gh.tags['fixture--v1.0.0']
  delete gh.tags['fixture--v1.0.0']
  // a maintainer edits the topics afterwards: the publication commit stays
  gh.pushEntry(entry({ version: 'v1.0.0', commit: repo.sha, topics: ['edited'] }), 'edit topics')
  const out = await run()
  assert.equal(out.decision, 'tag')
  assert.equal(gh.tags['fixture--v1.0.0'], published)
})

test('a version on main that the Releaser did not write is not tagged', async () => {
  const { gh, run } = setup({ entries: [ROOT_ENTRY, entry({ version: 'v1.0.0', commit: repo.sha })] })
  await assert.rejects(run(), /not a verified commit of octolab-releaser\[bot\]; a maintainer tags it/)
  // another bot, verified, with the same entry
  gh.pushEntry({ ...ROOT_ENTRY, topics: ['x'] })
  gh.pushEntry(entry({ version: null, commit: repo.sha }))
  gh.pushEntry(entry({ version: 'v1.0.0', commit: repo.sha }), 'chore(fixture): publish v1.0.0', { type: 'Bot', login: 'other[bot]', id: 1 })
  await assert.rejects(run(), /not a verified commit of octolab-releaser\[bot\]/)
  // the Releaser, but unverified
  gh.pushEntry(entry({ version: null, commit: repo.sha }))
  gh.push({ ...gh.head().files, [PATH]: format(entry({ version: 'v1.0.0', commit: repo.sha })) }, 'x', RELEASER, false)
  await assert.rejects(run(), /not a verified commit of octolab-releaser\[bot\]/)
  assert.equal(gh.tags['fixture--v1.0.0'], undefined)
})

test('a tag created concurrently on a later commit of main is accepted', async () => {
  const { gh, run } = setup()
  await run()
  const published = gh.tags['fixture--v1.0.0']
  delete gh.tags['fixture--v1.0.0']
  // another run tags a descendant holding the same release, after this run read main
  gh.beforeTag = () => {
    gh.pushEntry({ ...ROOT_ENTRY, topics: ['later'] })
    gh.tags['fixture--v1.0.0'] = gh.head().oid
  }
  const out = await run()
  assert.equal(out.decision, 'tag')
  assert.notEqual(out['catalog-commit'], published)
  assert.equal(out['catalog-commit'], gh.head().oid)
})

test('a prerelease is skipped successfully without any API call', async () => {
  const { gh, run } = setup({ tag: 'v1.0.0-rc.1' })
  const out = await run()
  assert.equal(out.decision, 'skip')
  assert.equal(out.changed, false)
  assert.deepEqual(gh.calls.rest, [])
})

test('the release tag must be a vX.Y.Z annotated, signed and verified tag at the checkout', async () => {
  await assert.rejects(setup({ tag: '1.0.0' }).run(), /release tags look like vX\.Y\.Z/)
  await assert.rejects(setup({ tag: 'v1.0.0+build' }).run(), /release tags look like vX\.Y\.Z/)
  const missing = setup()
  delete missing.gh.sourceTags['v1.0.0']
  await assert.rejects(missing.run(), /tag v1\.0\.0 not found/)
  const light = setup()
  light.gh.tagRelease('v1.0.0', repo.sha, { annotated: false })
  await assert.rejects(light.run(), /lightweight tag/)
  // a ref pointing at the signed tag object of another version
  const alias = setup()
  alias.gh.tagRelease('v1.0.0', repo.sha, { objectName: 'v0.9.0' })
  await assert.rejects(alias.run(), /points at the tag object of "v0\.9\.0"/)
  const unsigned = setup()
  unsigned.gh.tagRelease('v1.0.0', repo.sha, { verified: false })
  await assert.rejects(unsigned.run(), /does not verify its signature \(unsigned\)/)
  await assert.rejects(setup({ sha: 'f'.repeat(40) }).run(), /points at f{40}, but the checkout is at/)
  await assert.rejects(setup({ sourceSha: 'f'.repeat(40) }).run(), /source-sha f{40} is not the checked out commit/)
})

test('the tag must match the major version of the module path', async () => {
  await assert.rejects(setup({ tag: 'v2.0.0' }).run(), /no \/v2 suffix: Go requires the module path go\.octolab\.org\/toolset\/fixture\/v2/)
  const v2 = makeRepo({
    edit: (dir) => writeFileSync(join(dir, 'go.mod'), 'module go.octolab.org/toolset/fixture/v2\n\ngo 1.22\n'),
  })
  await assert.rejects(setup({ tag: 'v1.0.0', dir: v2.dir, sha: v2.sha }).run(), /a go\.octolab\.org\/toolset\/fixture\/v2 release is v2\.x\.y/)
  const { gh, run } = setup({ tag: 'v2.0.0', dir: v2.dir, sha: v2.sha })
  const out = await run()
  assert.equal(out.decision, 'publish')
  assert.equal(out['entry-path'], 'modules/go.octolab.org/toolset/fixture/v2.json')
  assert.equal(gh.entryAt('main', 'go.octolab.org/toolset/fixture/v2').version, 'v2.0.0')
})

test('only a root module is published', async () => {
  const nested = makeRepo({
    edit: (dir) => {
      mkdirSync(join(dir, 'sub'))
      renameSync(join(dir, 'go.mod'), join(dir, 'sub', 'go.mod'))
    },
  })
  await assert.rejects(setup({ dir: nested.dir, sha: nested.sha }).run(), /no go\.mod at the repository root/)
  await assert.rejects(setup({ dir: join(nested.dir, 'sub'), sha: nested.sha }).run(), /not the root of its repository/)
})

test('packages: auto follows the visibility, all and root are explicit', async () => {
  const cases = [
    ['auto', 'public', 'all'],
    ['auto', 'private', 'root'],
    ['auto', 'internal', 'root'],
    ['all', 'private', 'all'],
    ['root', 'public', 'root'],
  ]
  for (const [packages, visibility, scope] of cases) {
    const { gh, run } = setup({ metadata: { visibility }, packages })
    const out = await run()
    const e = gh.entryAt('main')
    assert.equal(e.scope, scope, `${packages}/${visibility}`)
    assert.equal(e.visibility, visibility)
    assert.deepEqual(e.packages, scope === 'all' ? FIXTURE_PACKAGES : [''])
    assert.equal(out.scope, scope)
  }
  await assert.rejects(setup({ packages: 'some' }).run(), /packages must be auto, all or root/)
})

test('dry-run decides and logs without writing', async () => {
  const lines = []
  const { gh, options } = setup()
  const out = await publish({ ...options, dryRun: true }, { ...gh.clients(), log: (l) => lines.push(l) })
  assert.equal(out.decision, 'publish')
  assert.equal(out.changed, false)
  assert.equal(out['catalog-tag'], '')
  assert.equal(gh.calls.graphql, 0)
  assert.deepEqual(gh.tags, {})
  assert.ok(gh.calls.rest.every((c) => c.startsWith('GET ')))
  const log = lines.join('\n')
  assert.match(log, /\+ {3}"version": "v1\.0\.0",/)
  assert.match(log, /decision: publish \(dry run, nothing written\)/)
  assert.match(log, /^Self-published: 1 of 2 modules; on seeds: 1 \(pkg\) \(with this release\)$/m)
  assert.equal(out.progress, 'Self-published: 1 of 2 modules; on seeds: 1 (pkg)')
  // a lost tag is not repaired in a dry run either
  await publish(options, gh.clients())
  delete gh.tags['fixture--v1.0.0']
  const repair = await publish({ ...options, dryRun: true }, gh.clients())
  assert.equal(repair.decision, 'tag')
  assert.equal(gh.tags['fixture--v1.0.0'], undefined)
})

test('a module claimed by another repository or name is refused', async () => {
  await assert.rejects(
    setup({ entries: [ROOT_ENTRY, entry({ repository: 'https://github.com/octopot/other' })] }).run(),
    /claimed by https:\/\/github\.com\/octopot\/other; a maintainer moves it/,
  )
  await assert.rejects(setup({ entries: [ROOT_ENTRY, entry({ name: 'old' })] }).run(), /published under the name old/)
  // the stored spelling of the repository is kept
  const { gh, run } = setup({ entries: [ROOT_ENTRY, entry({ repository: 'https://github.com/OctoPot/Fixture' })] })
  await run()
  assert.equal(gh.entryAt('main').repository, 'https://github.com/OctoPot/Fixture')
})

test('the catalog invariants hold for the result', async () => {
  const taken = entry({ module: 'go.octolab.org/ecosystem/fixture', packages: [''] })
  await assert.rejects(setup({ entries: [ROOT_ENTRY, taken] }).run(), /name fixture is taken/)
  assert.equal((await setup({ entries: [ROOT_ENTRY, taken], name: 'fixture-tool' }).run()).name, 'fixture-tool')
  const overlap = entry({ module: 'go.octolab.org/toolset', name: 'toolset', packages: ['', '/fixture/cmd/tool'] })
  await assert.rejects(setup({ entries: [ROOT_ENTRY, overlap] }).run(), /go\.octolab\.org\/toolset\/fixture\/cmd\/tool is listed by both/)
  await assert.rejects(setup({ entries: [] }).run(), /root module is missing/)
  const broken = setup()
  broken.gh.push({ ...broken.gh.head().files, [PATH]: '{}' }, 'broken')
  await assert.rejects(broken.run(), /a maintainer has to fix it/)
  await assert.rejects(setup({ name: 'Bad_Name' }).run(), /kebab-case/)
  const odd = setup({ callerRepository: 'octopot/Fix_ture' })
  odd.gh.alias = 'octopot/Fix_ture'
  await assert.rejects(odd.run(), /set the name input/)
})

test('a tag of the same name on another module is refused', async () => {
  const { gh, run } = setup()
  const other = entry({ module: 'go.octolab.org/ecosystem/other', name: 'fixture', packages: [''], version: 'v1.0.0' })
  gh.tags['fixture--v1.0.0'] = gh.push({ 'modules/go.octolab.org.json': format(ROOT_ENTRY), 'modules/go.octolab.org/ecosystem/other.json': format(other) }, 'other')
  await assert.rejects(run(), /for another module: the name fixture belongs to another module/)
})

test('a tag off main is refused', async () => {
  const { gh, run } = setup()
  await run()
  // rewrite history: main no longer contains the tagged commit
  const tagged = gh.tags['fixture--v1.0.0']
  gh.commits.push({ oid: 'f'.repeat(40), parent: gh.commits[0].oid, files: gh.commits[0].files, message: 'x', author: { type: 'User' }, verified: true })
  assert.notEqual(gh.head().oid, tagged)
  await assert.rejects(run(), /not on main/)
})

test('an unverified catalog commit is not tagged', async () => {
  const { gh, run } = setup()
  gh.verified = false
  await assert.rejects(run(), /does not report the commit as verified; refusing to tag it/)
  assert.deepEqual(gh.tags, {})
})

test('with packages auto, a visibility change never fails a retry', async () => {
  const { gh, run } = setup()
  await run()
  gh.metadata = { ...gh.metadata, visibility: 'private' }
  assert.equal((await run()).decision, 'published')
  const published = gh.tags['fixture--v1.0.0']
  delete gh.tags['fixture--v1.0.0']
  const out = await run()
  assert.equal(out.decision, 'tag')
  assert.equal(gh.tags['fixture--v1.0.0'], published)
  // an explicit scope is part of the release: root is another release
  await assert.rejects(run({ packages: 'root' }), /frozen/)
  // the next release follows the new visibility
  const next = makeRepo({ edit: (dir) => writeFileSync(join(dir, 'next.go'), 'package fixture\n') })
  gh.tagRelease('v1.1.0', next.sha)
  await run({ workspace: next.dir, sourceTag: 'v1.1.0' })
  assert.deepEqual(gh.entryAt('main').packages, [''])
})

test('an entry above 1 MB is read back through the blob API', async () => {
  const many = ['', ...Array.from({ length: 4999 }, (_, i) => `/very/long/package/path/segment/number/${String(i).padStart(4, '0')}/${'x'.repeat(220)}`)]
  const { gh, options } = setup()
  const deps = { ...gh.clients(), localModule: () => ({ module: MODULE, packages: many, commit: repo.sha }) }
  const first = await publish(options, deps)
  assert.equal(first.decision, 'publish')
  assert.ok(Buffer.byteLength(gh.head().files[PATH]) > 1024 * 1024)
  assert.equal((await publish(options, deps)).decision, 'published')
  delete gh.tags['fixture--v1.0.0']
  assert.equal((await publish(options, deps)).decision, 'tag')
})

test('a lost tag is repaired however long the history of the entry', async () => {
  const older = makeRepo({ edit: (dir) => writeFileSync(join(dir, 'older.go'), 'package fixture\n') })
  const { gh, run } = setup({ tag: 'v1.0.0', dir: older.dir, sha: older.sha })
  gh.tagRelease('v1.1.0', repo.sha)
  await run()
  const first = gh.tags['fixture--v1.0.0']
  delete gh.tags['fixture--v1.0.0']
  await run({ workspace: repo.dir, sourceTag: 'v1.1.0' })
  for (let i = 0; i < 620; i++) gh.pushEntry(entry({ version: 'v1.1.0', commit: repo.sha, topics: [`t${i}`] }))
  const out = await run()
  assert.equal(out.decision, 'tag')
  assert.equal(gh.tags['fixture--v1.0.0'], first)
})

test('the same version on main with another release is not tagged', async () => {
  for (const change of [{ packages: [''], scope: 'root' }, { commit: 'b'.repeat(40) }, { packages: FIXTURE_PACKAGES.slice(0, 3) }]) {
    const { gh, run } = setup()
    await run()
    delete gh.tags['fixture--v1.0.0']
    gh.pushEntry(entry({ version: 'v1.0.0', commit: repo.sha, ...change }), 'a maintainer edit')
    await assert.rejects(run(), /on main holds another commit, scope or packages/, JSON.stringify(change))
    assert.equal(gh.tags['fixture--v1.0.0'], undefined)
  }
})

test('repository metadata the entry rules refuse fails only a write', async () => {
  const { gh, run } = setup()
  await run()
  gh.metadata = { ...gh.metadata, default_branch: 'main+next' }
  assert.equal((await run()).decision, 'published')
  const next = makeRepo({ edit: (dir) => writeFileSync(join(dir, 'next.go'), 'package fixture\n') })
  gh.tagRelease('v1.1.0', next.sha)
  await assert.rejects(run({ workspace: next.dir, sourceTag: 'v1.1.0' }), /branch is not a valid branch name/)
})

test('a name with segments publishes under a tag with segments', async () => {
  const { gh, run } = setup({ name: 'ecosystem/fixture' })
  const out = await run()
  assert.equal(out['catalog-tag'], 'ecosystem/fixture--v1.0.0')
  assert.equal(gh.tags['ecosystem/fixture--v1.0.0'], gh.head().oid)
  assert.match(gh.head().message, /^chore\(ecosystem\/fixture\): publish v1\.0\.0/)
  assert.equal(gh.entryAt('main').name, 'ecosystem/fixture')
  assert.equal((await run()).decision, 'published')
  assert.ok(gh.calls.rest.includes('GET /repos/octolab/vanity/git/ref/tags/ecosystem/fixture--v1.0.0'))
  await assert.rejects(setup({ name: 'ecosystem//fixture' }).run(), /kebab-case segments/)
})

test('an entry that would render over another entry\'s package is refused before writing (S5)', async () => {
  const parent = entry({ module: 'go.octolab.org/toolset', name: 'toolset', packages: ['', '/fixture'] })
  const { gh, run } = setup({ entries: [ROOT_ENTRY, parent] })
  await assert.rejects(run(), /renders go\.octolab\.org\/toolset\/fixture, which go\.octolab\.org\/toolset publishes/)
  assert.equal(gh.calls.graphql, 0)
})

test('a module outside go.octolab.org is skipped with a warning, before the tag is checked', async () => {
  const foreign = makeRepo({ edit: (dir) => writeFileSync(join(dir, 'go.mod'), 'module github.com/someone/tool\n\ngo 1.22\n') })
  const { gh, options } = setup({ dir: foreign.dir, sha: foreign.sha })
  gh.tagRelease('v1.0.0', foreign.sha, { annotated: false }) // generated projects may not sign
  const warnings = []
  const out = await publish({ ...options, callerRepository: SOURCE }, { ...gh.clients(), warn: (m) => warnings.push(m) })
  assert.equal(out.decision, 'skip')
  assert.equal(out.changed, false)
  assert.equal(out.module, 'github.com/someone/tool')
  assert.match(warnings[0], /is not a go\.octolab\.org module: nothing to publish/)
  assert.ok(!gh.calls.rest.some((c) => c.includes('/octolab/vanity/')), 'no catalog call')
  assert.ok(!gh.calls.rest.some((c) => c.includes('/git/ref/tags/')), 'no tag check')
  // a tag that is no Go version at all skips too
  const odd = await publish({ ...options, sourceTag: 'v1.0' }, { ...gh.clients(), warn: () => {} })
  assert.equal(odd.decision, 'skip')
})

test('a project generated from a template that keeps its module path is skipped', async () => {
  const claimed = entry({ repository: 'https://github.com/octomation/go-module' })
  const { gh, options } = setup({ entries: [ROOT_ENTRY, claimed], metadata: { template_repository: { full_name: 'octomation/go-module' } } })
  gh.tagRelease('v1.0.0', repo.sha, { verified: false })
  const warnings = []
  const out = await publish(options, { ...gh.clients(), warn: (m) => warnings.push(m) })
  assert.equal(out.decision, 'skip')
  assert.match(warnings[0], /belongs to octomation\/go-module, the template this repository was generated from/)
  assert.equal(gh.calls.graphql, 0)
  assert.equal((await publish({ ...options, sourceTag: 'v1.0' }, { ...gh.clients(), warn: () => {} })).decision, 'skip')
  // generated from a template, its own module: published as usual
  const own = setup({ metadata: { template_repository: { full_name: 'octomation/go-module' } } })
  assert.equal((await own.run()).decision, 'publish')
  // not generated from it: the claim is a failure, a maintainer moves it
  await assert.rejects(setup({ entries: [ROOT_ENTRY, claimed] }).run(), /claimed by https:\/\/github\.com\/octomation\/go-module/)
})
