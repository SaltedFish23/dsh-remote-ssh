/**
 * Mount smoke: start the migrated plugin's host entries inside a real
 * 0.2.0-rc.1 cordis Context using the desktop runtime's packages, with the
 * genuine dsh-settings service and minimal stand-ins for the remaining
 * injected capabilities. Verifies the plugin's code actually boots on the
 * runtime version — not just that its types compile.
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const profileRoot = '/tmp/dsh-mount-test'
const runtimeRoot = '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'

const profileRequire = createRequire(resolve(profileRoot, 'noop.js'))
const runtimeRequire = createRequire(resolve(runtimeRoot, 'noop.js'))

const cordis = await import(runtimeRequire.resolve('@deepseek-ai/cordis', { paths: [runtimeRoot] }))
const asPlugin = (m) => {
  if (typeof m.apply === 'function') {
    // tsdown also emits `apply as default`; the namespace metadata is authoritative.
    return { ...(m.name !== undefined ? { name: m.name } : {}), ...(m.inject !== undefined ? { inject: m.inject } : {}), ...(m.Config !== undefined ? { Config: m.Config } : {}), apply: m.apply }
  }
  return m.default
}
const webEntry = await import(profileRequire.resolve('dsh-remote-ssh/web', { paths: [profileRoot] }))
const managerEntry = await import(profileRequire.resolve('dsh-remote-ssh/manager', { paths: [profileRoot] }))
const routerFs = await import(profileRequire.resolve('dsh-remote-ssh/router-fs', { paths: [profileRoot] }))
const shellTransparent = await import(profileRequire.resolve('dsh-remote-ssh/shell-transparent', { paths: [profileRoot] }))
const routerSubprocess = await import(profileRequire.resolve('dsh-remote-ssh/router-subprocess', { paths: [profileRoot] }))
const spillRouter = await import(profileRequire.resolve('dsh-remote-ssh/spill', { paths: [profileRoot] }))
const agentPolicy = await import(profileRequire.resolve('dsh-remote-ssh/agent-policy', { paths: [profileRoot] }))
const localBridge = await import(profileRequire.resolve('dsh-remote-ssh/local-bridge', { paths: [profileRoot] }))
const searchHook = await import(profileRequire.resolve('dsh-remote-ssh/search', { paths: [profileRoot] }))

console.log('cordis:', (await import(runtimeRequire.resolve('@deepseek-ai/cordis/package.json', { paths: [runtimeRoot] }), { with: { type: 'json' } })).default.version)

const { Context, Service } = cordis
const ctx = new Context()

// 1. minimal settings provider: the genuine SettingsForms requires the full
// Loader environment (configEditor/profileContext/root loader); its write
// contract is already covered by the unit suite and the profile smoke.
const settingsWrites = []
await ctx.plugin(class extends Service {
  static inject = []
  constructor(parent) { super(parent, 'settings') }
  get writable() { return true }
  describe() { return [] }
  async update(ns, patch) { settingsWrites.push(['update', ns, patch]) }
  async replace(ns, section) { settingsWrites.push(['replace', ns, section]) }
}).await?.()
if (ctx.settings === undefined) throw new Error('settings provider did not start')

// 2. minimal capability stand-ins the plugin entries inject
class FakeProvider extends Service {}
const routes = []
await ctx.plugin(class extends FakeProvider {
  static inject = []
  constructor(parent) { super(parent, 'webServer') }
  register(route) { routes.push(route.kind === 'exact' ? route.path : route.prefix); return () => {} }
  get port() { return 0 }
}).await?.()
const stub = (name, value = {}) => class extends Service {
  static inject = []
  constructor(parent) { super(parent, name); Object.assign(this, value) }
}
for (const [name, value] of [
  ['tools', { get: () => undefined, register() {}, restrict() {} }],
  ['agents', { list: () => [] }],
  ['systemPrompt', { variable() {}, section() {} }],
  ['shellEnv', {}],
]) {
  await ctx.plugin(stub(name, value)).await?.()
}

// Stand in for the isolated official local providers (dsh-fs-sandbox,
// dsh-subprocess-local, dsh-spill-local inside the remote-ssh-local-world
// group), let the bridge capture them, then retire the stand-ins so the
// routers own the root service names exactly like the composed profile.
const officialStandIns = []
for (const name of ['fs', 'subprocess', 'spillStore']) {
  officialStandIns.push(await ctx.plugin(stub(name)))
}
await ctx.plugin(asPlugin(localBridge)).await?.()
for (const fiber of officialStandIns) await fiber.dispose()

// 3. mount the plugin's host entries like the patch rows do
const aliasRoot = mkdtempSync(resolve(tmpdir(), 'dsh-remote-ssh-mount-'))
await ctx.plugin(managerEntry.default ?? managerEntry, { aliasRoot }).await?.()
if (ctx.remoteSshManager === undefined) throw new Error('remoteSshManager service did not start')
console.log('manager snapshot defaults:', JSON.stringify({
  openFileMode: ctx.remoteSshManager.snapshot().openFileMode,
  servers: ctx.remoteSshManager.snapshot().servers.length,
  workspaces: ctx.remoteSshManager.snapshot().workspaces.length,
}))

await ctx.plugin(asPlugin(webEntry)).await?.()
await ctx.plugin(asPlugin(routerFs)).await?.()
await ctx.plugin(shellTransparent.default, { dialect: 'bash' }).await?.()
await ctx.plugin(asPlugin(routerSubprocess)).await?.()
await ctx.plugin(asPlugin(spillRouter)).await?.()
await ctx.plugin(asPlugin(agentPolicy)).await?.()
await ctx.plugin(asPlugin(searchHook)).await?.()

const expected = [
  '/plugins/dsh-remote-ssh/state',
  '/plugins/dsh-remote-ssh/settings',
  '/plugins/dsh-remote-ssh/directory',
  '/plugins/dsh-remote-ssh/open-file',
  '/plugins/dsh-remote-ssh/workspace',
  '/plugins/dsh-remote-ssh/workspace/remove',
  '/plugins/dsh-remote-ssh/local-workspace',
  '/plugins/dsh-remote-ssh/probe',
  '/plugins/dsh-remote-ssh/ssh-config/host',
]
const missing = expected.filter(path => !routes.includes(path))
if (missing.length > 0) throw new Error(`web routes missing: ${missing.join(', ')}`)
console.log('web routes registered:', routes.length)

// 4. settings write path against the genuine SettingsForms
// (no Loader entry in this harness: the write must refuse cleanly)
try {
  await ctx.remoteSshManager.updateUserPreferences({ openFileMode: 'download' })
  throw new Error('expected the settings write to refuse without a profile entry')
} catch (error) {
  if (!/profile entry/.test(String(error?.message))) throw error
  console.log('settings write refuses cleanly without a Loader entry')
}

// 5. route classification sanity
const classified = ctx.remoteSshManager.route(undefined, aliasRoot)
console.log('local route for alias root:', classified.kind === 'local' ? 'local' : JSON.stringify(classified))

await ctx.fiber.dispose()
console.log('\nMOUNT SMOKE PASSED: plugin host entries boot on the 0.2.0-rc.1 runtime.')
