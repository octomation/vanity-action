// Test doubles: a module checkout made from the fixture, and a fake GitHub
// with the handful of REST and GraphQL endpoints the action uses, served both
// in-process and over HTTP.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { format } from '../scripts/entry.mjs'

export const FIXTURE = fileURLToPath(new URL('./fixtures/module', import.meta.url))
// the packages of the fixture, shared with the action's own CI
export const FIXTURE_PACKAGES = JSON.parse(readFileSync(new URL('./fixtures/module.packages.json', import.meta.url), 'utf8'))
export const MODULE = 'go.octolab.org/toolset/fixture'
export const SOURCE = 'octopot/fixture'
export const CATALOG = 'octolab/vanity'
export const RELEASER = { type: 'Bot', login: 'octolab-releaser[bot]', id: 336882174 }

// git runs git with no user or system configuration.
export const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim()

// makeRepo copies the fixture into a new git repository with one commit, and
// leaves untracked and ignored Go files beside it that must not count.
export function makeRepo({ fixture = FIXTURE, edit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vanity-action-repo-'))
  cpSync(fixture, dir, { recursive: true })
  if (edit) edit(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  for (const [path, body] of [
    ['untracked/u.go', 'package untracked\n'],
    ['generated/g.go', 'package generated\n'],
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  // a modified tracked file must not count either
  writeFileSync(join(dir, 'internal/mixed/a.go'), 'package changed\n')
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const blobSha = (s) => sha1(`blob ${Buffer.byteLength(s)}\0${s}`)
const b64 = (s) => Buffer.from(s).toString('base64')

export function entry(fields = {}) {
  return {
    schema: 1,
    name: 'fixture',
    module: MODULE,
    repository: `https://github.com/${SOURCE}`,
    branch: 'main',
    visibility: 'public',
    scope: 'all',
    packages: FIXTURE_PACKAGES,
    topics: ['go'],
    version: null,
    commit: 'c'.repeat(40),
    ...fields,
  }
}

export const ROOT_ENTRY = {
  schema: 1,
  name: 'pkg',
  module: 'go.octolab.org',
  repository: 'https://github.com/octolab/pkg',
  branch: 'master',
  visibility: 'public',
  scope: 'all',
  packages: ['', '/async', '/errors'],
  topics: [],
  version: null,
  commit: 'd'.repeat(40),
}

// FakeGitHub holds a source repository (metadata and release tags) and a
// catalog whose main is a list of snapshots.
export class FakeGitHub {
  constructor({ metadata = {}, entries = [ROOT_ENTRY] } = {}) {
    this.metadata = { full_name: SOURCE, default_branch: 'main', visibility: 'public', topics: ['go'], ...metadata }
    this.sourceTags = {} // tag -> { sha, annotated, verified }
    this.commits = []
    this.tags = {} // catalog tag -> oid
    this.calls = { graphql: 0, rest: [] }
    this.verified = true
    this.beforeCommit = null // hook run inside createCommitOnBranch
    this.beforeTag = null // hook run inside POST git/refs
    const files = {}
    for (const e of entries) files[`modules/${e.module}.json`] = format(e)
    this.push(files, 'seed', { type: 'User' })
  }

  head() {
    return this.commits[this.commits.length - 1]
  }

  push(files, message, author = { type: 'User' }, verified = true) {
    const parent = this.commits.length ? this.head().oid : null
    const oid = sha1(`commit ${this.commits.length} ${message} ${Math.random()}`)
    this.commits.push({ oid, parent, files, message, author, verified })
    return oid
  }

  // pushEntry writes one entry on main, as a maintainer or another run would.
  pushEntry(e, message = 'edit', author) {
    return this.push({ ...this.head().files, [`modules/${e.module}.json`]: format(e) }, message, author)
  }

  // tagRelease points refs/tags/<tag> at a tag object named objectName
  tagRelease(tag, sha, { annotated = true, verified = true, objectName = tag } = {}) {
    this.sourceTags[tag] = { sha, annotated, verified, name: objectName }
  }

  entryAt(ref, module = MODULE) {
    const c = this.find(ref)
    const raw = c?.files[`modules/${module}.json`]
    return raw ? JSON.parse(raw) : null
  }

  find(ref) {
    if (ref === 'main') return this.head()
    return this.commits.find((c) => c.oid === ref) || this.commits.find((c) => c.oid === this.tags[ref])
  }

  isAncestor(a, b) {
    let c = this.commits.find((x) => x.oid === b)
    while (c) {
      if (c.oid === a) return true
      c = this.commits.find((x) => x.oid === c.parent)
    }
    return false
  }

  async rest(method, url, body) {
    this.calls.rest.push(`${method} ${url}`)
    const [path, query = ''] = url.split('?')
    const q = new URLSearchParams(query)
    const seg = path.split('/').map(decodeURIComponent)
    const repo = `${seg[2]}/${seg[3]}`
    const rest = seg.slice(4)
    const err = (status, msg) => {
      const e = new Error(`${method} ${path}: ${status} ${msg}`)
      e.status = status
      throw e
    }
    if (repo === SOURCE || repo === this.alias) {
      if (method === 'GET' && !rest.length) return { ...this.metadata }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'tags') {
        const t = this.sourceTags[rest.slice(3).join('/')]
        if (!t) return null
        return t.annotated ? { object: { type: 'tag', sha: sha1(`tagobj ${t.name} ${t.sha}`) } } : { object: { type: 'commit', sha: t.sha } }
      }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'tags') {
        const t = Object.values(this.sourceTags).find((x) => sha1(`tagobj ${x.name} ${x.sha}`) === rest[2])
        if (!t) return null
        return { tag: t.name, object: { type: 'commit', sha: t.sha }, verification: { verified: t.verified, reason: t.verified ? 'valid' : 'unsigned' } }
      }
    }
    if (repo === CATALOG) {
      if (method === 'GET' && rest.join('/') === 'git/ref/heads/main') return { object: { type: 'commit', sha: this.head().oid } }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'trees') {
        const c = this.find(rest[2])
        if (!c) return null
        return {
          truncated: false,
          tree: Object.entries(c.files).map(([p, v]) => ({ path: p, type: 'blob', mode: '100644', sha: blobSha(v) })),
        }
      }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'blobs') {
        for (const c of this.commits) for (const v of Object.values(c.files)) if (blobSha(v) === rest[2]) return { content: b64(v), encoding: 'base64' }
        return null
      }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'tags') {
        const t = this.tags[rest.slice(3).join('/')]
        return t ? { object: { type: 'commit', sha: t } } : null
      }
      if (method === 'GET' && rest[0] === 'contents') {
        const c = this.find(q.get('ref'))
        const v = c?.files[rest.slice(1).join('/')]
        if (v === undefined) return null
        // above 1 MB GitHub returns no content
        if (Buffer.byteLength(v) > 1024 * 1024) return { type: 'file', sha: blobSha(v), content: '', encoding: 'none' }
        return { type: 'file', sha: blobSha(v), content: b64(v), encoding: 'base64' }
      }
      if (method === 'GET' && rest[0] === 'compare') {
        const [a, b] = rest[1].split('...')
        return { status: a === b ? 'identical' : this.isAncestor(a, b) ? 'ahead' : 'diverged' }
      }
      if (method === 'GET' && rest[0] === 'commits' && rest.length === 1) {
        const file = q.get('path')
        const out = []
        let c = this.commits.find((x) => x.oid === q.get('sha'))
        while (c) {
          const p = this.commits.find((x) => x.oid === c.parent)
          if (c.files[file] !== p?.files[file]) {
            out.push({ sha: c.oid, commit: { verification: { verified: c.verified } }, author: c.author })
          }
          c = p
        }
        const per = Number(q.get('per_page') || 30)
        const page = Number(q.get('page') || 1)
        return out.slice((page - 1) * per, page * per)
      }
      if (method === 'GET' && rest[0] === 'commits' && rest.length === 2) {
        const c = this.commits.find((x) => x.oid === rest[1])
        return c ? { sha: c.oid, commit: { verification: { verified: c.verified && this.verified } } } : null
      }
      if (method === 'POST' && rest.join('/') === 'git/refs') {
        if (this.beforeTag) {
          const hook = this.beforeTag
          this.beforeTag = null
          hook()
        }
        const name = body.ref.replace(/^refs\/tags\//, '')
        if (this.tags[name]) err(422, 'Reference already exists')
        this.tags[name] = body.sha
        return { ref: body.ref, object: { sha: body.sha } }
      }
    }
    if (method === 'GET' && repo !== SOURCE && repo !== CATALOG) return null
    err(500, `fake: unexpected ${method} ${url}`)
  }

  async graphql(_query, { input }) {
    this.calls.graphql++
    if (this.beforeCommit) this.beforeCommit()
    if (input.branch.repositoryNameWithOwner !== CATALOG || input.branch.branchName !== 'main') throw new Error('fake: wrong branch')
    if (input.expectedHeadOid !== this.head().oid) {
      const e = new Error('stale')
      e.graphql = [{ type: 'STALE_DATA', message: `Expected branch to point to "${input.expectedHeadOid}" but it did not.` }]
      throw e
    }
    const files = { ...this.head().files }
    for (const { path, contents } of input.fileChanges.additions) files[path] = Buffer.from(contents, 'base64').toString()
    for (const { path } of input.fileChanges.deletions || []) delete files[path]
    const oid = this.push(files, `${input.message.headline}\n\n${input.message.body}`, RELEASER, this.verified)
    return { createCommitOnBranch: { commit: { oid, url: `https://github.com/${CATALOG}/commit/${oid}` } } }
  }

  // clients serves the fake in-process.
  clients() {
    const gh = { rest: (...a) => this.rest(...a), graphql: (...a) => this.graphql(...a) }
    return { catalogClient: gh, sourceClient: gh, log: () => {}, notice: () => {}, wait: async () => {} }
  }

  // listen serves the fake over HTTP, the way the action sees GitHub.
  async listen() {
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(value === undefined ? '' : JSON.stringify(value))
      }
      if (!/^Bearer \S+$/.test(req.headers.authorization || '')) return send(401, { message: 'Bad credentials' })
      try {
        if (req.url === '/graphql') {
          try {
            return send(200, { data: await this.graphql(body.query, body.variables) })
          } catch (e) {
            return send(200, { data: null, errors: e.graphql || [{ message: e.message }] })
          }
        }
        const value = await this.rest(req.method, req.url, body)
        if (value === null) return send(404, { message: 'Not Found' })
        return send(req.method === 'POST' ? 201 : 200, value)
      } catch (e) {
        return send(e.status || 500, { message: e.message })
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    return `http://127.0.0.1:${server.address().port}`
  }

  close() {
    return new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()))
  }
}
