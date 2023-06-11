#!/usr/bin/env node
// The action's entry point: maps the inputs from action.yml to publish or
// entry, writes the outputs and the step summary. Exit codes: 0 success or
// nothing to do, 1 refused or an API failure, 2 usage.

import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { entryCommand } from './cli.mjs'
import { entryPath, format } from './entry.mjs'
import { requireTools, UsageError } from './go.mjs'
import { publish } from './publish.mjs'

// input reads an action input the way @actions/core does.
const input = (name, env = process.env) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || '').trim()

// escape keeps a message on one workflow command line.
export const escape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const OUTPUTS = ['decision', 'changed', 'catalog-commit', 'catalog-tag', 'module', 'name', 'entry-path']

function writeOutputs(out, env) {
  if (!env.GITHUB_OUTPUT) return
  const lines = OUTPUTS.filter((k) => out[k] !== undefined).map((k) => `${k}=${String(out[k]).replace(/[\r\n]/g, ' ')}\n`)
  appendFileSync(env.GITHUB_OUTPUT, lines.join(''))
}

function writeSummary(out, env, dryRun) {
  if (!env.GITHUB_STEP_SUMMARY) return
  const cell = (s) => String(s ?? '').replace(/[|\r\n<>`]/g, ' ')
  const rows = [
    '| Module | Decision | Scope | Packages | Catalog tag |',
    '|:--|:--|:--|--:|:--|',
    `| \`${cell(out.module)}\` ${cell(out.version)} | ${cell(out.decision)}${dryRun ? ' (dry run)' : ''} | ${cell(out.scope)} | ${cell(out.packageCount)} | ${cell(out['catalog-tag']) || '—'} |`,
  ]
  const progress = out.progress ? `\n${cell(out.progress)}${dryRun ? ' (with this release)' : ''}\n` : ''
  appendFileSync(env.GITHUB_STEP_SUMMARY, `### go.octolab.org\n\n${rows.join('\n')}\n${progress}`)
}

export async function main(env = process.env, deps = {}) {
  const command = input('command', env) || 'publish'
  try {
    requireTools()
    switch (command) {
      case 'publish': {
        const missing = ['token', 'source-tag'].filter((n) => !input(n, env))
        if (missing.length) throw new UsageError(`publish needs the input(s): ${missing.join(', ')}`)
        const dry = input('dry-run', env) || 'false'
        if (!['true', 'false'].includes(dry)) throw new UsageError(`dry-run must be true or false, not ${dry}`)
        const ref = env.GITHUB_ACTION_REF
        const repository = env.GITHUB_ACTION_REPOSITORY || 'octomation/vanity-action'
        const out = await publish(
          {
            workspace: env.GITHUB_WORKSPACE || process.cwd(),
            token: input('token', env),
            githubToken: input('github-token', env),
            sourceTag: input('source-tag', env),
            sourceSha: input('source-sha', env),
            callerRepository: env.GITHUB_REPOSITORY,
            catalog: input('catalog-repository', env) || 'octolab/vanity',
            name: input('name', env),
            packages: input('packages', env) || 'auto',
            dryRun: dry === 'true',
            publisher: ref ? `${repository}@${ref}` : repository,
          },
          deps,
        )
        writeOutputs(out, env)
        writeSummary(out, env, dry === 'true')
        break
      }
      case 'entry': {
        const entry = await entryCommand(
          { path: env.GITHUB_WORKSPACE || process.cwd(), name: input('name', env) || undefined, packages: input('packages', env) || 'auto' },
          { env: { ...env, GITHUB_TOKEN: input('github-token', env) } },
        )
        process.stdout.write(format(entry))
        const out = { decision: 'entry', module: entry.module, name: entry.name, 'entry-path': entryPath(entry.module), scope: entry.scope, packageCount: entry.packages.length }
        writeOutputs(out, env)
        writeSummary(out, env, false)
        break
      }
      default:
        throw new UsageError(`command must be publish or entry, not ${command}`)
    }
    return 0
  } catch (err) {
    console.log(`::error::${escape(err.message)}`)
    return err instanceof UsageError ? 2 : 1
  }
}

// isMain compares real paths: a file URL built from argv by hand breaks on
// spaces, non-ASCII and symlinked install paths.
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await main()
