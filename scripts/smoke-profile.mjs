/**
 * Migration smoke check: compose the real 0.2.0-rc.1 web profile tree
 * (official bundle patches + the user's live patch + this plugin's patch)
 * using the exact cordis-plugin-include version shipped in the desktop
 * runtime, then report which official entries the plugin patch targets.
 *
 * Read-only: loads YAML/JSON from the desktop app extract and this repo.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'

// Resolve packages from the desktop runtime, not from this repo's dev deps.
const runtimeRequire = createRequire(resolve(runtimeRoot, 'noop.js'))
const include = await import(runtimeRequire.resolve('@deepseek-ai/cordis-plugin-include', { paths: [runtimeRoot] }))
const { load } = (await import('file://' + runtimeRequire.resolve('js-yaml', { paths: [resolve(repoRoot, 'node_modules')] })))

const warnings = []
const warn = (message, ...args) => { warnings.push([message, ...args].join(' ')) }

function readYaml(path) {
  return load(readFileSync(path, 'utf8'), { schema: include.entryListSchema })
}

// 1. official bundle layers for the web profile
const officialBundles = ['dsh-base', 'dsh-web-app']
let rows = []
for (const bundle of officialBundles) {
  const patchPath = resolve(runtimeRoot, bundle, 'cordis.patch.yml')
  rows = include.applyEntryPatches(rows, readYaml(patchPath), warn)
}
const officialIds = new Set(rows.map(row => row.id))
let lastRowCount = rows.length

// 2. the user's live web-profile patch
const userPatch = readYaml(resolve(process.env.HOME, '.dsh/profiles/web/cordis.patch.yml'))
rows = include.applyEntryPatches(rows, userPatch, warn)

// 3. this plugin's patch (as the profile bundle layer would apply it)
const pluginPatch = readYaml(resolve(repoRoot, 'cordis.patch.yml'))
rows = include.applyEntryPatches(rows, pluginPatch, warn)

lastRowCount = rows.length
const byId = new Map(rows.map(row => [row.id, row]))

// 4. report: every patch op that targets an official id must hit a live row
const results = []
for (const op of pluginPatch) {
  if (op.id === undefined) continue
  const kind = op.disabled === true ? 'disable' : op.insert !== undefined ? 'insert' : 'configure'
  if (kind === 'insert') {
    results.push([kind, op.id, byId.has(op.id) ? 'inserted' : 'MISSING'])
  } else {
    const official = officialIds.has(op.id)
    results.push([kind, op.id, byId.has(op.id) ? (official ? 'hits official entry' : 'no such entry') : 'MISSING'])
  }
}

console.log('compose warnings:', warnings.length === 0 ? 'none' : warnings)
console.log('official rows:', officialIds.size, 'final rows:', rows.size)
let failures = 0
for (const [kind, id, status] of results) {
  const bad = status === 'MISSING' || status === 'no such entry'
  if (bad) failures += 1
  console.log(`${bad ? '✗' : '✓'} ${kind.padEnd(9)} ${id.padEnd(34)} ${status}`)
}
if (failures > 0) {
  console.log(`\n${failures} patch target(s) did not resolve — the patch would silently no-op.`)
  process.exit(1)
}
console.log('\nAll plugin patch targets resolve against the live 0.2.0-rc.1 web profile tree.')
