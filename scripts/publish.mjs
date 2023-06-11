// Publishes a module's release into the catalog: one entry
// modules/<module path>.json written in one GitHub-signed commit on main, and
// one lightweight tag <name>--vX.Y.Z on that commit. No clone, no branch,
// nothing else. See README.md for the contract.

import { client, encodePath, repositoryMetadata } from './github.mjs'
import { RefusedError, UsageError, checkoutRoot, git } from './go.mjs'
import {
  byteSort,
  catalogProgress,
  catalogTag,
  checkCatalog,
  checkEntry,
  checkName,
  compareStable,
  entryPath,
  format,
  identity,
  localModule,
  majorProblem,
  MODULES,
  parseEntry,
  parseVersion,
  resolveScope,
  SCHEMA,
} from './entry.mjs'

export const ATTEMPTS = 5
// The OctoLab Releaser App: the only author whose earlier publication a run
// tags without writing it (contract: identity fixed by the API).
export const RELEASER = { login: 'octolab-releaser[bot]', id: 336882174 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const refuse = (message) => {
  throw new RefusedError(message)
}
const backoff = (attempt) => 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500)

// --- the source: the caller's repository and its release tag ---------------------

// releaseCommit requires the tag to be annotated, signed and verified by GitHub,
// and returns the commit it points at.
async function releaseCommit(rest, repository, tag) {
  const fix = `replace it with an annotated tag signed by a key of your GitHub account: git tag -s ${tag}`
  const ref = await rest('GET', `/repos/${encodePath(repository)}/git/ref/tags/${encodePath(tag)}`)
  if (!ref) refuse(`${repository}: tag ${tag} not found`)
  if (ref.object.type !== 'tag') refuse(`${tag}: a lightweight tag; release tags are annotated and signed, ${fix}`)
  const obj = await rest('GET', `/repos/${encodePath(repository)}/git/tags/${ref.object.sha}`)
  if (!obj) refuse(`${tag}: tag object ${ref.object.sha} not found`)
  // the signature covers the tag object, whose own name must be the version:
  // a ref may point at an object signed for another tag
  if (obj.tag !== tag) refuse(`${tag}: the ref points at the tag object of ${JSON.stringify(obj.tag)}; ${fix}`)
  if (obj.object?.type !== 'commit') refuse(`${tag}: points at a ${obj.object?.type}, not a commit; ${fix}`)
  if (!obj.verification?.verified) {
    refuse(`${tag}: GitHub does not verify its signature (${obj.verification?.reason || 'unsigned'}); ${fix}`)
  }
  return obj.object.sha
}

// --- the catalog ------------------------------------------------------------------

async function headOf(rest, catalog) {
  const ref = await rest('GET', `/repos/${catalog}/git/ref/heads/main`)
  if (!ref) refuse(`${catalog}: no main branch, or the token can't read it`)
  return ref.object.sha
}

// catalogState reads main: its head and every file under modules/.
async function catalogState(rest, catalog, blobs) {
  const oid = await headOf(rest, catalog)
  const tree = await rest('GET', `/repos/${catalog}/git/trees/${oid}?recursive=1`)
  if (!tree) refuse(`${catalog}@${oid}: tree not found`)
  if (tree.truncated) refuse(`${catalog}@${oid}: the tree is too large to read in one request`)
  const files = new Map()
  for (const item of tree.tree) {
    if (!item.path.startsWith(`${MODULES}/`) || item.type === 'tree') continue
    if (item.type !== 'blob' || item.mode === '120000') {
      files.set(item.path, Buffer.from(`not a regular file (${item.type} ${item.mode})`))
      continue
    }
    if (!blobs.has(item.sha)) {
      const blob = await rest('GET', `/repos/${catalog}/git/blobs/${item.sha}`)
      if (!blob) refuse(`${catalog}: blob ${item.sha} of ${item.path} not found`)
      blobs.set(item.sha, Buffer.from(blob.content, blob.encoding === 'utf-8' ? 'utf8' : 'base64'))
    }
    files.set(item.path, blobs.get(item.sha))
  }
  return { oid, files }
}

// tagCommit returns the commit a catalog tag points at, or null.
async function tagCommit(rest, catalog, tag) {
  const ref = await rest('GET', `/repos/${catalog}/git/ref/tags/${encodePath(tag)}`)
  if (!ref) return null
  if (ref.object.type === 'commit') return ref.object.sha
  const obj = await rest('GET', `/repos/${catalog}/git/tags/${ref.object.sha}`)
  return obj?.object?.type === 'commit' ? obj.object.sha : refuse(`${catalog}: tag ${tag} does not point at a commit`)
}

// entryAt reads the module's entry at a ref, or null. Above 1 MB the contents
// API returns no content (encoding none): the blob API reads it by its sha.
async function entryAt(rest, catalog, module, ref) {
  const res = await rest('GET', `/repos/${catalog}/contents/${encodePath(entryPath(module))}?ref=${encodeURIComponent(ref)}`)
  if (!res || res.type !== 'file') return null
  let content = res.content
  let encoding = res.encoding
  if (encoding !== 'base64') {
    const blob = await rest('GET', `/repos/${catalog}/git/blobs/${res.sha}`)
    if (!blob) return null
    content = blob.content
    encoding = blob.encoding
  }
  try {
    return JSON.parse(Buffer.from(content, encoding === 'utf-8' ? 'utf8' : 'base64').toString('utf8'))
  } catch {
    return null
  }
}

// onMain reports whether a commit is reachable from the head of main.
async function onMain(rest, catalog, sha, head) {
  if (sha === head) return true
  const cmp = await rest('GET', `/repos/${catalog}/compare/${sha}...${head}`)
  return cmp?.status === 'ahead' || cmp?.status === 'identical'
}

// publication finds the commit on main, at or before head, that wrote the
// given version of the module: the oldest commit of the newest run of commits
// whose entry holds that version.
async function publication(rest, catalog, module, version, head) {
  const path = encodeURIComponent(entryPath(module))
  let found = null
  // the whole history of the entry: one commit per change of this module
  for (let page = 1; ; page++) {
    const commits = await rest('GET', `/repos/${catalog}/commits?sha=${head}&path=${path}&per_page=100&page=${page}`)
    for (const c of commits || []) {
      const e = await entryAt(rest, catalog, module, c.sha)
      if (e?.version === version) {
        const releaser = c.author?.type === 'Bot' && c.author?.login === RELEASER.login && c.author?.id === RELEASER.id
        found = { sha: c.sha, entry: e, verified: !!c.commit?.verification?.verified, releaser }
      } else if (found) {
        return found
      }
    }
    if (!commits || commits.length < 100) break
  }
  return found
}

// requireVerified waits for GitHub to report the commit as verified: an
// unverified commit is never tagged.
async function requireVerified(rest, catalog, oid, wait) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const c = await rest('GET', `/repos/${catalog}/commits/${oid}`)
    if (c?.commit?.verification?.verified) return
    if (attempt < 6) await wait(2000 * attempt)
  }
  refuse(`${catalog}@${oid}: GitHub does not report the commit as verified; refusing to tag it`)
}

// createTag creates the catalog tag; when it exists already (a concurrent run
// of the same release), it is accepted only on the same commit or on a commit
// on main that publishes the same release.
async function createTag(rest, catalog, tag, oid, module, same) {
  try {
    await rest('POST', `/repos/${catalog}/git/refs`, { ref: `refs/tags/${tag}`, sha: oid })
    return oid
  } catch (err) {
    if (err.status !== 422) throw err
  }
  const existing = await tagCommit(rest, catalog, tag)
  if (!existing) refuse(`${catalog}: creating ${tag} failed, and the tag doesn't exist`)
  if (existing === oid) return oid
  const published = await entryAt(rest, catalog, module, existing)
  if (!published || !same(published) || !(await onMain(rest, catalog, existing, await headOf(rest, catalog)))) {
    refuse(`${tag} was created concurrently on ${existing} with another release`)
  }
  return existing
}

const HOST = 'go.octolab.org'
const sameRepository = (a, b) => a.toLowerCase() === b.toLowerCase()

const isStale = (err) =>
  (err.graphql || []).some((e) => e.type === 'STALE_DATA' || /expected branch to point to/i.test(e.message || ''))

const CREATE_COMMIT = `
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid url }
  }
}`

// diff is a line diff of two small texts, for the log.
export function diff(before, after) {
  const a = before ? before.split('\n') : []
  const b = after.split('\n')
  if (a.length * b.length > 4e6) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)].join('\n')
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`)
    else out.push(`- ${a[i++]}`)
  }
  return out.join('\n')
}

// --- publish ------------------------------------------------------------------------

// publish runs one publication. opts: workspace, sourceTag, sourceSha,
// callerRepository, catalog, name, packages, dryRun, publisher. deps replace
// the API clients, logging and waiting in tests.
export async function publish(opts, deps = {}) {
  const log = deps.log || console.log
  const escape = (m) => String(m).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const notice = deps.notice || ((m) => log(`::notice::${escape(m)}`))
  const warn = deps.warn || ((m) => log(`::warning title=Vanity::${escape(m)}`))
  const wait = deps.wait || sleep
  const cat = deps.catalogClient || client(opts.token)
  const src = deps.sourceClient || client(opts.githubToken)
  const catalog = opts.catalog || 'octolab/vanity'
  const tag = opts.sourceTag
  const caller = opts.callerRepository
  if (!caller || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(caller)) throw new UsageError(`the caller repository ${caller} is not owner/name`)
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(catalog)) throw new UsageError(`catalog-repository ${catalog} is not owner/name`)

  // an invalid tag fails only after the skips below: a generated project may
  // push any v* tag
  const v = parseVersion(tag)
  if (v?.pre.length) {
    notice(`${tag} is a prerelease: the catalog keeps stable releases only, nothing to publish`)
    return { decision: 'skip', changed: false }
  }

  if (opts.name) checkName(opts.name)
  if (!['auto', 'all', 'root'].includes(opts.packages || 'auto')) throw new UsageError(`packages must be auto, all or root, not ${opts.packages}`)
  const meta = await repositoryMetadata(src.rest, caller)
  const scope = resolveScope(opts.packages || 'auto', meta.visibility)

  const root = checkoutRoot(opts.workspace)
  if (!root) refuse(`${opts.workspace}: not a git checkout; check out the repository at the workspace root first`)
  const head = git(root, ['rev-parse', 'HEAD'])
  if (opts.sourceSha && opts.sourceSha !== head) refuse(`source-sha ${opts.sourceSha} is not the checked out commit ${head}`)

  // all packages are listed whatever the scope: with packages auto, a
  // published release keeps the scope it was published with
  const local = (deps.localModule || localModule)(root, { commit: head, scope: 'all' })

  // A project generated from a template keeps the template's job. It has
  // nothing to publish while its module path is outside the catalog, or is
  // still the template's own: a warning and a green run, never a failure.
  // Checked before the release tag, which such a project may not sign.
  const skip = (message) => {
    warn(message)
    log('decision: skip')
    return { decision: 'skip', changed: false, module: local.module, 'entry-path': '', 'catalog-commit': '', 'catalog-tag': '' }
  }
  if (local.module !== HOST && !local.module.startsWith(`${HOST}/`)) {
    return skip(`${local.module} is not a ${HOST} module: nothing to publish. Remove the vanity job, or declare a ${HOST} module path in go.mod.`)
  }
  if (meta.template) {
    const claimed = await entryAt(cat.rest, catalog, local.module, 'main')
    if (claimed && sameRepository(claimed.repository, `https://github.com/${meta.template}`) && !sameRepository(claimed.repository, `https://github.com/${caller}`)) {
      return skip(`${local.module} belongs to ${meta.template}, the template this repository was generated from: nothing to publish. Rename the module in go.mod, or remove the vanity job.`)
    }
  }

  if (!v) throw new UsageError(`source-tag ${tag}: release tags look like vX.Y.Z`)
  const name = checkName(opts.name || caller.split('/')[1], opts.name ? null : caller.split('/')[1])
  const released = await releaseCommit(src.rest, caller, tag)
  if (released !== head) refuse(`${tag} points at ${released}, but the checkout is at ${head}; check out the tag`)
  const problem = majorProblem(local.module, tag)
  if (problem) refuse(problem)
  const entryFor = (s) => ({
    schema: SCHEMA,
    name,
    module: local.module,
    repository: `https://github.com/${caller}`,
    branch: meta.branch,
    visibility: meta.visibility,
    scope: s,
    packages: s === 'root' ? [''] : local.packages,
    topics: byteSort(new Set(meta.topics)),
    version: tag,
    commit: local.commit,
  })
  const entry = entryFor(scope)
  // the release itself must be valid now; the repository metadata only when
  // an entry is written, so that it never fails a retry
  const problems = checkEntry({ ...entry, repository: 'https://github.com/o/r', branch: 'main', visibility: 'public', topics: [] })
  if (problems.length) refuse(problems.join('; '))
  // sameRelease compares a published entry with this release: with packages
  // auto, in the scope it was published with, so a visibility change never
  // fails a retry
  const sameRelease = (published) => {
    const s = opts.packages === 'auto' || !opts.packages ? published.scope : scope
    return identity(published) === identity(s === 'all' || s === 'root' ? entryFor(s) : entry)
  }
  const path = entryPath(entry.module)
  const ctag = catalogTag(name, tag)
  const base = { module: entry.module, 'entry-path': path, name, scope, packageCount: entry.packages.length, version: tag }
  log(`${entry.module} ${tag} (${name}): scope ${scope}, ${entry.packages.length} package(s), commit ${entry.commit}`)

  const blobs = new Map()
  const done = (decision, fields) => {
    const out = { ...base, decision, changed: false, 'catalog-commit': '', 'catalog-tag': '', ...fields }
    log(`decision: ${decision}${opts.dryRun ? ' (dry run, nothing written)' : ''}`)
    return out
  }

  for (let attempt = 1; ; attempt++) {
    // A published release is frozen: its tag either holds this release or
    // the run fails. Checked on every attempt: a concurrent run may have
    // finished in between.
    const tagged = await tagCommit(cat.rest, catalog, ctag)
    if (tagged) {
      const published = await entryAt(cat.rest, catalog, entry.module, tagged)
      if (!published || published.name !== name) {
        refuse(`${ctag} already exists on ${tagged} for another module: the name ${name} belongs to another module, set the name input`)
      }
      if (!sameRelease(published)) {
        refuse(`${ctag} already exists on ${tagged} with another release of ${entry.module}; a published release is frozen, ship a new version`)
      }
      if (!(await onMain(cat.rest, catalog, tagged, await headOf(cat.rest, catalog)))) {
        refuse(`${ctag} points at ${tagged}, which is not on main of ${catalog}; a maintainer has to look at it`)
      }
      if (published.repository.toLowerCase() !== entry.repository.toLowerCase()) {
        log(`::warning::${ctag} was published from ${published.repository}, not ${entry.repository}`)
      }
      log(`${ctag} is already published`)
      return done('published', { 'catalog-commit': tagged, 'catalog-tag': ctag })
    }

    const state = await catalogState(cat.rest, catalog, blobs)
    const raw = state.files.get(path)
    let current = null
    if (raw) {
      const { entry: e, errors } = parseEntry(raw, path)
      if (errors.length) refuse(`${catalog}: ${errors.join('; ')}; a maintainer has to fix it`)
      current = e
    }
    if (current) {
      if (current.repository.toLowerCase() !== entry.repository.toLowerCase()) {
        refuse(`${entry.module} is claimed by ${current.repository}; a maintainer moves it to ${entry.repository}`)
      }
      if (current.name !== entry.name) {
        refuse(`${entry.module} is published under the name ${current.name}, not ${entry.name}; set the name input to ${current.name}, or a maintainer renames it`)
      }
      // keep the stored spelling: a module never changes repository here
      entry.repository = current.repository
    }

    if (current?.version) {
      const order = compareStable(tag, current.version)
      if (order <= 0) {
        // the version reached main once: find that commit and tag it if the
        // tag is missing; a version that never reached main is a backport
        const pub = await publication(cat.rest, catalog, entry.module, tag, state.oid)
        if (!pub) {
          if (order === 0) refuse(`${entry.module} ${tag} is on main, but no commit on main wrote it; a maintainer has to look at it`)
          notice(`${catalog} already holds ${entry.module} ${current.version}; ${tag} is older and was never published, nothing to do`)
          return done('backport')
        }
        if (!sameRelease(pub.entry)) {
          refuse(`${entry.module} ${tag} was published on ${pub.sha} with another commit, scope or packages; a published release is frozen, ship a new version`)
        }
        if (order === 0 && identity(current) !== identity(pub.entry)) {
          refuse(`${entry.module} ${tag} on main holds another commit, scope or packages than its publication ${pub.sha}; a published release is frozen, a maintainer has to look at it`)
        }
        if (order === 0 && format(current) !== format(entry)) {
          log(`${path}: the repository metadata changed since ${tag} was published; the next release refreshes it`)
        }
        if (!pub.releaser || !pub.verified) {
          refuse(`${pub.sha} published ${entry.module} ${tag} but is not a verified commit of ${RELEASER.login}; a maintainer tags it ${ctag}`)
        }
        log(`${entry.module} ${tag} is on main without ${ctag}; tagging ${pub.sha}`)
        if (opts.dryRun) return done('tag', { 'catalog-commit': pub.sha })
        const oid = await createTag(cat.rest, catalog, ctag, pub.sha, entry.module, sameRelease)
        return done('tag', { 'catalog-commit': oid, 'catalog-tag': ctag })
      }
    }

    // write: a new module, a seeded one, or a newer version
    const bytes = format(entry)
    const files = new Map(state.files)
    files.set(path, Buffer.from(bytes))
    const errors = checkCatalog(files)
    if (errors.length) refuse(`the catalog with this entry is invalid: ${errors.join('; ')}`)
    // the migration from seeds, as the catalog stands with this entry
    const progress = catalogProgress(files).text
    log(`${progress}${opts.dryRun ? ' (with this release)' : ''}`)

    log(`${path}:\n${diff(raw ? raw.toString('utf8') : '', bytes)}`)
    if (opts.dryRun) return done('publish', { progress })

    const packages = scope === 'root' ? 'root (1 package)' : `all (${entry.packages.length} packages)`
    let created
    try {
      const data = await cat.graphql(CREATE_COMMIT, {
        input: {
          branch: { repositoryNameWithOwner: catalog, branchName: 'main' },
          message: {
            headline: `chore(${name}): publish ${tag}`,
            body: [
              `Source: ${caller}@${entry.commit} (${tag})`,
              `Module: ${entry.module}`,
              `Scope: ${packages}`,
              `Publisher: ${opts.publisher || 'octomation/vanity-action'}`,
            ].join('\n'),
          },
          expectedHeadOid: state.oid,
          fileChanges: { additions: [{ path, contents: Buffer.from(bytes).toString('base64') }] },
        },
      })
      created = data.createCommitOnBranch.commit
    } catch (err) {
      if (!isStale(err)) throw err
      if (attempt >= ATTEMPTS) refuse(`main of ${catalog} kept moving; ${ATTEMPTS} attempts failed, run it again`)
      log(`main moved while publishing (attempt ${attempt}); retrying`)
      await wait(backoff(attempt))
      continue
    }

    await requireVerified(cat.rest, catalog, created.oid, wait)
    const oid = await createTag(cat.rest, catalog, ctag, created.oid, entry.module, (e) => identity(e) === identity(entry))
    log(`published ${created.url} as ${ctag}`)
    return done('publish', { changed: true, 'catalog-commit': oid, 'catalog-tag': ctag, progress })
  }
}
