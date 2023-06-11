// The local side of an entry: the released commit's tree, its module path and
// its packages, from git and the runner's go. Every call goes through
// execFile, never a shell.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export class UsageError extends Error {}
export class RefusedError extends Error {}

const HELPER = fileURLToPath(new URL('./packages.go', import.meta.url))

// goEnv isolates go from the caller's configuration: no workspace, no env
// file, no flags, no toolchain switch, no network. The helper runs in GOPATH
// mode (modules 'off'): it imports the standard library only. GOOS and GOARCH are left to
// the runner: the helper runs there, and decides on its own that the target
// doesn't matter.
export function goEnv(modules = 'on', base = process.env) {
  const env = { ...base }
  delete env.GOOS
  delete env.GOARCH
  delete env.GOPATH
  return {
    ...env,
    GOWORK: 'off',
    GOENV: 'off',
    GOFLAGS: '',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOPRIVATE: '',
    GONOSUMDB: '',
    GONOPROXY: '',
    GOINSECURE: '',
    GO111MODULE: modules,
    CGO_ENABLED: '0',
  }
}

const gitEnv = (base = process.env) => ({ ...base, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' })

function exec(file, args, options) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...options })
  } catch (err) {
    if (err.code === 'ENOENT') throw new UsageError(`${file} is not on PATH; set it up before the action`)
    const detail = (err.stderr || err.message || '').toString().trim()
    throw new RefusedError(`${file} ${args.join(' ')}: ${detail}`)
  }
}

export const git = (cwd, args, env) => exec('git', args, { cwd, env: gitEnv(env) }).trim()

// requireTools fails with a usage error when go or git is missing.
export function requireTools() {
  exec('git', ['--version'], {})
  exec('go', ['version'], { env: goEnv() })
}

// checkoutRoot returns the top level of the work tree at dir when dir is
// that top level, null when dir is not in a work tree, and throws when dir is
// inside one but not its root: v0.1.0 publishes root modules only.
export function checkoutRoot(dir) {
  let top
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() }).trim()
  } catch (err) {
    if (err.code === 'ENOENT') throw new UsageError('git is not on PATH; set it up before the action')
    return null
  }
  if (realpathSync(top) !== realpathSync(dir)) {
    throw new RefusedError(`${dir} is not the root of its repository ${top}: only a module with go.mod at the repository root can be published`)
  }
  return top
}

// materialize writes the commit's Go sources into a fresh directory, the way
// the commit holds them, not the way the working directory happens to be: no
// generated, ignored or modified files, export-ignore'd files kept. Blobs are
// read as objects (ls-tree, cat-file), so no checkout filter, eol conversion
// or LFS smudge of the caller's configuration touches them. Only what the
// lister reads is written: *.go files and go.mod files; symbolic links and
// submodules are left out. The caller removes the returned directory.
export function materialize(repo, commit) {
  const base = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'vanity-action-'))
  const tree = join(base, 'tree')
  try {
    mkdirSync(tree)
    const listing = exec('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: repo, env: gitEnv() })
    const files = []
    for (const record of listing.split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      const [mode, type, sha] = record.slice(0, tab).split(' ')
      const path = record.slice(tab + 1)
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (!name.endsWith('.go') && name !== 'go.mod') continue
      if (path.startsWith('/') || path.split('/').some((p) => p === '' || p === '.' || p === '..' || p === '.git')) continue
      files.push({ path, sha })
    }
    if (files.length) {
      const res = spawnSync('git', ['cat-file', '--batch'], {
        cwd: repo,
        env: gitEnv(),
        input: files.map((f) => f.sha).join('\n') + '\n',
        maxBuffer: 1 << 30,
      })
      if (res.error) throw res.error.code === 'ENOENT' ? new UsageError('git is not on PATH; set it up before the action') : res.error
      if (res.status !== 0) throw new RefusedError(`git cat-file --batch: ${res.stderr.toString().trim()}`)
      const out = res.stdout
      let at = 0
      for (const f of files) {
        const nl = out.indexOf(0x0a, at)
        const header = out.subarray(at, nl).toString()
        const [sha, type, size] = header.split(' ')
        if (sha !== f.sha || type !== 'blob') throw new RefusedError(`git cat-file: unexpected ${header} for ${f.path}`)
        const body = out.subarray(nl + 1, nl + 1 + Number(size))
        at = nl + 1 + Number(size) + 1
        const dest = join(tree, ...f.path.split('/'))
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, body)
      }
    }
  } catch (err) {
    rmSync(base, { recursive: true, force: true })
    throw err
  }
  return { dir: tree, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

// modulePath reads the module path from go.mod with a pure parse: it works
// with an empty module cache and a go directive newer than the runner's Go.
export function modulePath(dir) {
  if (!existsSync(join(dir, 'go.mod'))) {
    throw new RefusedError('no go.mod at the repository root: only a module with go.mod at the repository root can be published')
  }
  const out = exec('go', ['mod', 'edit', '-json'], { cwd: dir, env: goEnv() })
  const path = JSON.parse(out)?.Module?.Path
  if (!path) throw new RefusedError('go.mod declares no module path')
  return path
}

// listPackages runs the helper with the runner's go from a neutral directory,
// so no go.mod on the way changes how go runs it.
export function listPackages(dir) {
  const cwd = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'vanity-action-go-'))
  try {
    const out = exec('go', ['run', HELPER, dir], { cwd, env: goEnv('off') })
    return out.split('\n').filter((line, i) => line !== '' || i === 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
