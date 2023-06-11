// The entry command: the canonical entry of a local module, for the action's
// command entry and for maintainers (the catalog's seed).

import { resolve } from 'node:path'

import { buildEntry, checkName, isStable, localModule, majorProblem, resolveScope } from './entry.mjs'
import { client, repositoryMetadata } from './github.mjs'
import { RefusedError, UsageError } from './go.mjs'

export const ENTRY_USAGE = `usage: vanity-action entry [--path DIR] [--name NAME] [--packages auto|all|root]
                          [--repository OWNER/NAME] [--branch B] [--visibility V]
                          [--topics a,b] [--commit SHA] [--version vX.Y.Z]`

const FLAGS = ['path', 'name', 'packages', 'repository', 'branch', 'visibility', 'topics', 'commit', 'version']

export function parseFlags(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    let value
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}\n${ENTRY_USAGE}`)
    arg = arg.slice(2)
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      value = arg.slice(eq + 1)
      arg = arg.slice(0, eq)
    } else {
      if (i + 1 >= argv.length) throw new UsageError(`--${arg} needs a value\n${ENTRY_USAGE}`)
      value = argv[++i]
    }
    if (!FLAGS.includes(arg)) throw new UsageError(`unknown flag --${arg}\n${ENTRY_USAGE}`)
    if (arg in opts) throw new UsageError(`--${arg} is given twice`)
    opts[arg] = value
  }
  return opts
}

// entryCommand builds the entry of the module at opts.path. Metadata not given
// on flags comes from GET /repos/{repository} with GITHUB_TOKEN.
export async function entryCommand(opts, { env = process.env, rest } = {}) {
  const repository = opts.repository || env.GITHUB_REPOSITORY
  if (!repository || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new UsageError('--repository OWNER/NAME is required outside GitHub Actions')
  }
  if (opts.version !== undefined && !isStable(opts.version)) throw new UsageError(`--version ${opts.version}: must be vX.Y.Z`)
  if (opts.commit !== undefined && !/^[0-9a-f]{40}$/.test(opts.commit)) throw new UsageError(`--commit ${opts.commit}: must be a full commit hash`)
  const defaultName = repository.split('/')[1]
  const name = checkName(opts.name ?? defaultName, opts.name === undefined ? defaultName : null)
  let meta = { branch: opts.branch, visibility: opts.visibility, topics: opts.topics === undefined ? undefined : opts.topics.split(',').map((t) => t.trim()).filter(Boolean) }
  if (meta.branch === undefined || meta.visibility === undefined || meta.topics === undefined) {
    const fetched = await repositoryMetadata(rest || client(env.GITHUB_TOKEN || env.GH_TOKEN, { env }).rest, repository)
    meta = { branch: meta.branch ?? fetched.branch, visibility: meta.visibility ?? fetched.visibility, topics: meta.topics ?? fetched.topics }
  }
  const scope = resolveScope(opts.packages || 'auto', meta.visibility)
  const local = localModule(resolve(opts.path || '.'), { commit: opts.commit, scope })
  if (opts.version) {
    const problem = majorProblem(local.module, opts.version)
    if (problem) throw new RefusedError(problem)
  }
  return buildEntry({
    name,
    module: local.module,
    repository: `https://github.com/${repository}`,
    branch: meta.branch,
    visibility: meta.visibility,
    scope,
    packages: local.packages,
    topics: meta.topics,
    version: opts.version ?? null,
    commit: local.commit,
  })
}
