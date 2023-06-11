// The catalog entry: its canonical bytes, its rules, the catalog invariants,
// Go's version rules, and the entry of a local module. The same rules hold in
// octolab/vanity (bin/catalog.py); keep them in step.

import { RefusedError, UsageError, checkoutRoot, git, listPackages, materialize, modulePath } from './go.mjs'

export const SCHEMA = 1
export const MODULES = 'modules'
export const KEYS = ['schema', 'name', 'module', 'repository', 'branch', 'visibility', 'scope', 'packages', 'topics', 'version', 'commit']
export const MAX_PACKAGES = 5000
export const MAX_TOPICS = 20

// A name is one or more kebab-case segments joined by "/", e.g. indexit or
// ecosystem/tablo. Its catalog tag <name>--vX.Y.Z is always a valid git ref,
// and tags of any two names coexist: a segment never holds "--", so no tag
// is a directory of another (refs/tags/a--v1.0.0 beside refs/tags/a/b--v1.0.0).
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/
export const MAX_NAME = 64
const MODULE = /^go\.octolab\.org(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*$/
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const BRANCH = /^[A-Za-z0-9._/-]+$/
const PACKAGE = /^(\/[A-Za-z0-9._~+-]+)+$/
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/
const COMMIT = /^[0-9a-f]{40}$/
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// semver.org with a leading v; build metadata is not a Go module version
const SEMVER =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

// --- canonical form ---------------------------------------------------------------

export function format(entry) {
  const ordered = {}
  for (const k of KEYS) ordered[k] = entry[k]
  return JSON.stringify(ordered, null, 2) + '\n'
}

export const entryPath = (module) => `${MODULES}/${module}.json`
export const catalogTag = (name, version) => `${name}--${version}`
export const byteSort = (list) => [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))

// --- versions ---------------------------------------------------------------------

export function parseVersion(v) {
  const m = SEMVER.exec(String(v))
  if (!m) return null
  // BigInt: the grammar has no upper bound, Number loses precision past 2^53
  return { major: BigInt(m[1]), minor: BigInt(m[2]), patch: BigInt(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

export const isStable = (v) => STABLE.test(String(v))

// compareStable orders two stable versions.
export function compareStable(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  return 0
}

// majorProblem applies Go's major version rule: a module path without a
// /vN suffix takes v0 and v1 versions, a path ending in /vN (N >= 2) takes
// vN versions only. Returns a problem or null.
export function majorProblem(module, version) {
  const v = parseVersion(version)
  const bad = suffixProblem(module)
  if (bad) return bad
  // Go's own reading (module.SplitPathVersion): a last element of v and
  // digits or dots is a major version suffix, valid only as /vN, N >= 2,
  // without dots or a leading zero
  const m = /\/v([0-9.]+)$/.exec(module)
  if (m) {
    const n = BigInt(m[1])
    if (v.major !== n) return `${version} does not match the major version suffix of ${module}; a ${module} release is v${n}.x.y`
    return null
  }
  if (v.major > 1n) {
    return `${version} is major version ${v.major}, but ${module} has no /v${v.major} suffix: Go requires the module path ${module}/v${v.major} for it`
  }
  return null
}

// suffixProblem rejects a module path Go reads as having an invalid major
// version suffix: /v0, /v1, /v02, /v2.1.
export function suffixProblem(module) {
  const m = /\/v([0-9.]+)$/.exec(module)
  if (m && (!/^[1-9]\d*$/.test(m[1]) || BigInt(m[1]) < 2n)) return `${module}: a major version suffix must be /v2 or higher, digits only`
  return null
}

// --- rules ------------------------------------------------------------------------

const isStr = (v) => typeof v === 'string'

function segmentsOK(p) {
  return p
    .slice(1)
    .split('/')
    .every((s) => s !== '.' && s !== '..' && s !== 'testdata' && s !== 'vendor' && !s.startsWith('.') && !s.startsWith('_'))
}

// checkEntry returns the problems of an entry; with path, it also checks that
// the entry is at its own path.
export function checkEntry(e, path) {
  const at = path || 'entry'
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [`${at}: not an object`]
  const errors = []
  const add = (msg) => errors.push(`${at}: ${msg}`)
  const keys = Object.keys(e)
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) add(`keys must be exactly ${KEYS.join(', ')}, in this order`)
  if (e.schema !== SCHEMA) add(`schema must be ${SCHEMA}`)
  if (!isStr(e.name) || !NAME.test(e.name) || e.name.length > MAX_NAME) add(`name must be kebab-case segments (a-z, 0-9, -) joined by /, at most ${MAX_NAME} characters`)
  if (!isStr(e.module) || !MODULE.test(e.module) || e.module.includes('..')) add('module must be go.octolab.org or a path under it')
  else {
    if (path && path !== entryPath(e.module)) add(`module ${e.module} belongs at ${entryPath(e.module)}`)
    const bad = suffixProblem(e.module)
    if (bad) add(bad)
  }
  if (!isStr(e.repository) || !REPOSITORY.test(e.repository) || e.repository.endsWith('.git')) add('repository must be https://github.com/<owner>/<name>')
  if (!isStr(e.branch) || !BRANCH.test(e.branch) || e.branch.startsWith('-') || e.branch.startsWith('/') || e.branch.includes('..')) add('branch is not a valid branch name')
  if (!['public', 'private', 'internal'].includes(e.visibility)) add('visibility must be public, private or internal')
  if (!['all', 'root'].includes(e.scope)) add('scope must be all or root')
  if (!Array.isArray(e.packages) || !e.packages.every(isStr)) {
    add('packages must be a list of strings')
  } else {
    const p = e.packages
    if (p[0] !== '') add('packages must start with "" (the module root)')
    if (p.length > MAX_PACKAGES) add(`at most ${MAX_PACKAGES} packages`)
    if (new Set(p).size !== p.length) add('packages must be unique')
    if (JSON.stringify(byteSort(p)) !== JSON.stringify(p)) add('packages must be sorted')
    const bad = p.slice(1).filter((x) => !PACKAGE.test(x) || !segmentsOK(x))
    if (bad.length) add(`invalid packages: ${bad.slice(0, 5).join(', ')}`)
    if (e.scope === 'root' && (p.length !== 1 || p[0] !== '')) add('scope root lists the root package only')
  }
  if (!Array.isArray(e.topics) || !e.topics.every(isStr)) {
    add('topics must be a list of strings')
  } else {
    const t = e.topics
    if (t.length > MAX_TOPICS) add(`at most ${MAX_TOPICS} topics`)
    if (new Set(t).size !== t.length) add('topics must be unique')
    if (JSON.stringify(byteSort(t)) !== JSON.stringify(t)) add('topics must be sorted')
    const bad = t.filter((x) => !TOPIC.test(x))
    if (bad.length) add(`invalid topics: ${bad.join(', ')}`)
  }
  if (e.version !== null && !(isStr(e.version) && isStable(e.version))) add('version must be null or vX.Y.Z')
  else if (e.version !== null && isStr(e.module) && MODULE.test(e.module)) {
    const problem = majorProblem(e.module, e.version)
    if (problem) add(problem)
  }
  if (!isStr(e.commit) || !COMMIT.test(e.commit)) add('commit must be a full lowercase commit hash')
  return errors
}

// parseEntry reads the bytes of a catalog file: valid JSON, ASCII, canonical.
export function parseEntry(bytes, path) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(text)) return { errors: [`${path}: must be ASCII`] }
  let e
  try {
    e = JSON.parse(text)
  } catch (err) {
    return { errors: [`${path}: ${err.message}`] }
  }
  const errors = checkEntry(e, path)
  if (!errors.length && format(e) !== text) errors.push(`${path}: not in the canonical format (two-space JSON, keys in order, a final newline)`)
  return { entry: e, errors }
}

// rendered lists the pages the renderer writes for an entry: its packages and
// every parent of them inside the module.
export function rendered(e) {
  const pages = new Set()
  for (let p of e.packages) {
    for (;;) {
      pages.add(e.module + p)
      if (!p) break
      p = p.slice(0, p.lastIndexOf('/'))
    }
  }
  return pages
}

// checkCatalog checks the invariants of a whole catalog, given as a map of
// path -> bytes of every file under modules/:
//   S1 every file is a valid entry at its own path
//   S2 the root module go.octolab.org exists
//   S3 full package paths are disjoint across entries
//   S4 names are unique across entries
//   S5 no entry renders a page (a parent of its packages) that another entry
//      publishes as a package: the renderer would overwrite that page
// catalogProgress counts, in a catalog that passed checkCatalog, the modules
// whose releases publish them and the seeds (version null) still waiting for
// their first release.
export function catalogProgress(files) {
  const seeds = []
  let total = 0
  for (const [path, bytes] of files) {
    const { entry, errors } = parseEntry(bytes, path)
    if (errors.length) continue
    total++
    if (entry.version === null) seeds.push(entry.name)
  }
  seeds.sort()
  const text = `Self-published: ${total - seeds.length} of ${total} modules; on seeds: ${seeds.length}${seeds.length ? ` (${seeds.join(', ')})` : ''}`
  return { published: total - seeds.length, total, seeds, text }
}

export function checkCatalog(files) {
  const errors = []
  const entries = []
  for (const [path, bytes] of files) {
    if (!path.endsWith('.json')) {
      errors.push(`${path}: only entries modules/<module path>.json belong under ${MODULES}/`)
      continue
    }
    const { entry, errors: problems } = parseEntry(bytes, path)
    errors.push(...problems)
    if (!problems.length) entries.push(entry)
  }
  if (!files.has(entryPath('go.octolab.org'))) errors.push(`${entryPath('go.octolab.org')}: the root module is missing`)
  const owners = new Map()
  for (const e of entries) {
    for (const p of e.packages) {
      const full = e.module + p
      const other = owners.get(full)
      if (other) errors.push(`package ${full} is listed by both ${other} and ${e.module}`)
      else owners.set(full, e.module)
    }
  }
  for (const e of entries) {
    for (const page of [...rendered(e)].sort()) {
      const other = owners.get(page)
      if (other && other !== e.module) errors.push(`${e.module} renders ${page}, which ${other} publishes as a package`)
    }
  }
  const names = new Map()
  for (const e of entries) {
    const other = names.get(e.name)
    if (other) errors.push(`name ${e.name} is taken by both ${other} and ${e.module}`)
    else names.set(e.name, e.module)
  }
  return errors
}

// identity is what a published release can't change: retries compare it, and
// mutable repository metadata (branch, visibility, topics) stays out of it.
export const identity = (e) => JSON.stringify([e.name, e.module, e.version, e.commit, e.scope, e.packages])

// --- the entry of a local module -----------------------------------------------------

export function resolveScope(packages, visibility) {
  if (packages === 'all' || packages === 'root') return packages
  if (packages === 'auto') return visibility === 'public' ? 'all' : 'root'
  throw new UsageError(`packages must be auto, all or root, not ${packages}`)
}

export function checkName(name, repository) {
  if (!NAME.test(name) || name.length > MAX_NAME) {
    throw new UsageError(
      `name ${JSON.stringify(name)} must be kebab-case segments (a-z, 0-9, -) joined by /, at most ${MAX_NAME} characters` +
        (repository ? `; the repository name ${repository} doesn't fit, set the name input` : ''),
    )
  }
  return name
}

// localModule lists the module at dir. A git checkout is read at commit (HEAD
// by default) from a fresh copy of its tracked files; a plain directory, such
// as a tree already materialized, is read as it is and needs commit.
export function localModule(dir, { commit, scope }) {
  const root = checkoutRoot(dir)
  let tree
  if (root) {
    const head = git(root, ['rev-parse', '--verify', `${commit || 'HEAD'}^{commit}`])
    if (commit && head !== commit) throw new UsageError(`commit ${commit} is not a full commit hash in ${root}`)
    commit = head
    tree = materialize(root, commit)
  } else {
    if (!commit) throw new UsageError(`${dir} is not the root of a git checkout; pass --commit to list a plain directory`)
    tree = { dir, cleanup: () => {} }
  }
  try {
    const module = modulePath(tree.dir)
    const packages = scope === 'root' ? [''] : normalizePackages(listPackages(tree.dir))
    return { module, packages, commit }
  } finally {
    tree.cleanup()
  }
}

export function normalizePackages(list) {
  return byteSort(new Set(['', ...list]))
}

// buildEntry assembles an entry and fails with every problem it has.
export function buildEntry({ name, module, repository, branch, visibility, scope, packages, topics, version = null, commit }) {
  const entry = {
    schema: SCHEMA,
    name,
    module,
    repository,
    branch,
    visibility,
    scope,
    packages,
    topics: byteSort(new Set(topics || [])),
    version,
    commit,
  }
  const errors = checkEntry(entry)
  if (errors.length) throw new RefusedError(errors.join('; '))
  return entry
}
