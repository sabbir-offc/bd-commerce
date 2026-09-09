/**
 * Prints one version's section of CHANGELOG.md, for GitHub release notes.
 *
 *   node scripts/ci/changelog-section.mjs 0.4.0
 *
 * Matches the heading `## <version>` with anything after it, so a section
 * titled `## 0.4.0` or `## 0.4.0 — 2026-09-10` both work.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version) {
  console.error('usage: changelog-section.mjs <version>')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n')

const start = lines.findIndex((line) => line.startsWith(`## ${version}`))
if (start === -1) {
  console.error(`No section for ${version} in CHANGELOG.md`)
  process.exit(1)
}

const rest = lines.slice(start + 1)
const end = rest.findIndex((line) => line.startsWith('## '))
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

console.log(body)
