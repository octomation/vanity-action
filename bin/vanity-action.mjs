#!/usr/bin/env node
// The entry of a module for the go.octolab.org catalog, for maintainers:
//
//   vanity-action entry [--path DIR] [--name NAME] [--packages auto|all|root]
//                       [--repository OWNER/NAME] [--branch B] [--visibility V]
//                       [--topics a,b] [--commit SHA] [--version vX.Y.Z]
//
// prints the canonical modules/<module path>.json. Publishing runs only in
// the action. Exit codes: 0 done, 1 refused or failed, 2 usage.

import { ENTRY_USAGE, entryCommand, parseFlags } from '../scripts/cli.mjs'
import { format } from '../scripts/entry.mjs'
import { requireTools, UsageError } from '../scripts/go.mjs'

const [command, ...args] = process.argv.slice(2)

try {
  if (command !== 'entry') throw new UsageError(ENTRY_USAGE)
  requireTools()
  process.stdout.write(format(await entryCommand(parseFlags(args))))
} catch (err) {
  console.error(err.message)
  process.exit(err instanceof UsageError ? 2 : 1)
}
