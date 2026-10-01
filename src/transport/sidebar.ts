import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix } from 'node:path'
import type { ContentEncoding } from '@microsoft/agent-host-protocol'
import type { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { RemoteSshManager, RemoteWorkspaceRoute } from '../routing/manager.ts'
import { routeRemoteOs } from '../routing/manager.ts'
import { fileUriFromPosixPath, quotePosix } from './runtime.ts'
import { isRemoteAbsolutePath, normalizeRemotePath, remotePathKey, toNativeRemotePath, type RemoteOs } from './remote-paths.ts'
import { buildPowerShellProcessScript } from './powershell.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSshSidebarHook: object
  }
}

const SIDEBAR_PACKAGE = 'dsh-better-sidebar'
const GIT_HOOK_SYMBOL_NAME = 'dsh-remote-ssh.sidebar-git'
const LIST_HOOK_SYMBOL_NAME = 'dsh-remote-ssh.sidebar-list'
const READ_HOOK_SYMBOL_NAME = 'dsh-remote-ssh.sidebar-read'
// The injected branches look these up via Symbol.for(name); the registrations
// below MUST use the same symbol keys, never the plain string keys.
const GIT_HOOK_SYMBOL = Symbol.for(GIT_HOOK_SYMBOL_NAME)
const LIST_HOOK_SYMBOL = Symbol.for(LIST_HOOK_SYMBOL_NAME)
const READ_HOOK_SYMBOL = Symbol.for(READ_HOOK_SYMBOL_NAME)

/** Stock shapes seen in the wild: the published bundle (`cwd, args, timeoutMs
 *  = 3e4`), the TypeScript source (typed params + return types), and the
 *  compact dev-loader emission without spaces. */
const RUN_GIT_START = /(?:async\s+)?function runGit\(\s*cwd\s*(?::\s*string)?\s*,\s*args\s*(?::\s*(?:readonly\s+)?string\[\])?\s*,\s*timeoutMs\s*=\s*[^,)]*?\s*\)\s*(?::\s*Promise\s*<\s*string\s*>\s*)?\{/
const READ_DIRECTORY_START = /async\s+function\s+readDirectory\(\s*path\s*(?::\s*string)?\s*,\s*maxEntries\s*(?::\s*number)?\s*\)\s*(?::\s*Promise\s*<\s*[^>]*?\s*>\s*)?\{/
const READ_TEXT_START = /async\s+function\s+readText\(\s*path\s*(?::\s*string)?\s*,\s*readLimit\s*(?::\s*number)?\s*\)\s*(?::\s*Promise\s*<\s*[^>]*?\s*>\s*)?\{/
const RUN_GIT_HOOK = `\n\tconst bridged = globalThis[Symbol.for(${JSON.stringify(GIT_HOOK_SYMBOL_NAME)})]?.(cwd, args, timeoutMs);\n\tif (bridged !== void 0) return bridged;`
const READ_DIRECTORY_HOOK = `\n\tconst bridged = globalThis[Symbol.for(${JSON.stringify(LIST_HOOK_SYMBOL_NAME)})]?.(path, maxEntries);\n\tif (bridged !== void 0) return bridged;`
const READ_TEXT_HOOK = `\n\tconst bridged = globalThis[Symbol.for(${JSON.stringify(READ_HOOK_SYMBOL_NAME)})]?.(path, readLimit);\n\tif (bridged !== void 0) return bridged;`

/** Stock default of dsh-better-sidebar's runGit. */
const STOCK_TIMEOUT_MS = 30_000
/** Stock timeouts are local-disk budgets; one remote call adds SSH/PTY setup,
 *  so every bridged command gets at least this much wall time. */
const REMOTE_TIMEOUT_FLOOR_MS = 15_000
/** Output redirects are read back whole; these caps only bound a pathological
 *  command (the stock runner accumulates unbounded stdout in comparison). */
const STDOUT_MAX_BYTES = 64 * 1024 * 1024
const STDERR_MAX_BYTES = 1024 * 1024
/** Binary head the stock reader returns for client-side viewer detection. */
const READ_HEAD_LIMIT = 4096
/** Remembered repo/worktree roots per host process, oldest-evicted. */
const REMEMBERED_ROOT_LIMIT = 128
/** Boot-order self-heal delay: entries start concurrently, so a sidebar that
 *  raced ahead of the transform is remounted shortly after quiescence. */
const REMOUNT_DELAY_MS = 1_500
/** Bound on one self-heal loader step (in-flight settle, re-init). */
const REMOUNT_SETTLE_TIMEOUT_MS = 15_000

const BASE64 = 'base64' as ContentEncoding

/** Branch injected into stock runGit: undefined keeps local execution. */
type SidebarGitHook = (cwd: string, args: readonly string[], timeoutMs?: number) => Promise<string> | undefined
/** Branch injected into stock readDirectory: undefined keeps local listing. */
type SidebarListHook = (path: string, maxEntries: number) => Promise<SidebarListing> | undefined
/** Branch injected into stock readText: undefined keeps local reading. */
type SidebarReadHook = (path: string, readLimit: number) => Promise<SidebarRead> | undefined

interface HookGlobals {
  [GIT_HOOK_SYMBOL]?: SidebarGitHook
  [LIST_HOOK_SYMBOL]?: SidebarListHook
  [READ_HOOK_SYMBOL]?: SidebarReadHook
}
type HookGlobal = typeof globalThis & HookGlobals

/** Row shape of stock `readDirectory` (fs-tree.ts SidebarFsEntry). */
export interface SidebarListingRow {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  broken: boolean
  hidden: boolean
}

/** Result shape of stock `readDirectory` (fs-tree.ts SidebarFsListing). */
export interface SidebarListing {
  path: string
  entries: SidebarListingRow[]
  truncated: boolean
}

/** Result shape of stock `readText` (index.ts). */
export interface SidebarRead {
  content: string
  truncated: boolean
  binary: boolean
  size: number
  head?: string
}

export const name = 'dsh-remote-ssh-sidebar-bridge'
export const inject = ['loader']

/**
 * Route dsh-better-sidebar into remote workspaces.
 *
 * The sidebar touches the workspace with three host-local primitives: it
 * spawns the local `git` binary with `-C <session cwd>`, lists directory
 * levels with local `readdir`, and reads editor files with local `fs`. For a
 * Remote SSH session every one of those lands on the workspace's empty local
 * alias directory — the SCM panel reports "not a git repository" and the
 * explorer shows nothing. This module plants a remote-aware branch at the top
 * of each stock function while leaving the rest of the sidebar untouched:
 *
 * - `runGit` runs git on the SSH host, stdout/stderr redirected into runtime
 *   files and read back byte-exact over AHP, so NUL-framed porcelain output
 *   never crosses a PTY; failures reject with stock GitCommandError's shape;
 * - `readDirectory` lists one remote level per AHP `resourceList` call and
 *   emits rows in REMOTE POSIX path space (the same space git roots and
 *   tool-event paths already use, so read/change markers keep matching);
 * - `readText` stats and reads through the workspace's AHP filesystem,
 *   preserving the stock truncated/binary/head contract.
 *
 * Ordering: Node's loader hooks (`registerHooks` / `module.register`) cannot
 * retrofit a loader that has already been initialized, which is exactly the
 * state of the host's internal cascaded loader by the time any plugin runs.
 * The branches are therefore written INTO the installed dsh-better-sidebar
 * bundle file (idempotent, backup kept, signature-guarded), and a delayed
 * self-heal remounts the sidebar when it was already imported from the
 * unpatched file. Gating the sidebar entry on `remoteSshSidebarHook` from the
 * profile's own patch layer is still recommended: it makes the sidebar mount
 * after the bridge exists, so the common path needs no remount.
 */
export function apply(ctx: Context): void {
  const remembered = new Map<string, RemoteWorkspaceRoute>()

  let manager: RemoteSshManager | undefined
  ctx.inject(['remoteSshManager'], managerCtx => {
    manager = managerCtx.remoteSshManager
    managerCtx.effect(() => () => {
      if (manager === managerCtx.remoteSshManager) manager = undefined
    }, 'Remote SSH sidebar bridge manager attachment')
  })
  const requireManager = (): RemoteSshManager => {
    if (manager === undefined) throw new Error('dsh-remote-ssh: remote workspace manager is not available yet')
    return manager
  }

  const gitHook: SidebarGitHook = (cwd, args, timeoutMs) => wrapHook(() => {
    const route = sidebarBridgeRoute(requireManager(), remembered, cwd)
    if (route === undefined) return undefined
    return runRemoteGit(requireManager(), route, remembered, cwd, args, timeoutMs)
  })
  const listHook: SidebarListHook = (path, maxEntries) => wrapHook(() => {
    const route = sidebarBridgeRoute(requireManager(), remembered, path)
    if (route === undefined) return undefined
    return listRemoteDirectory(requireManager(), route, path, maxEntries)
  })
  const readHook: SidebarReadHook = (path, readLimit) => wrapHook(() => {
    const route = sidebarBridgeRoute(requireManager(), remembered, path)
    if (route === undefined) return undefined
    return readRemoteText(requireManager(), route, path, readLimit)
  })

  const target = globalThis as HookGlobal
  const previous = {
    git: target[GIT_HOOK_SYMBOL],
    list: target[LIST_HOOK_SYMBOL],
    read: target[READ_HOOK_SYMBOL],
  }
  target[GIT_HOOK_SYMBOL] = gitHook
  target[LIST_HOOK_SYMBOL] = listHook
  target[READ_HOOK_SYMBOL] = readHook

  // Node's loader hooks cannot retrofit an already-initialized internal
  // loader, so the branches are written into the installed bundle file
  // instead. A patch written during THIS boot can still be too late for a
  // sidebar that already imported; the self-heal below remounts it.
  let patchedThisBoot = false
  try {
    const file = sidebarBundleFile(ctx)
    if (file !== undefined) patchedThisBoot = patchSidebarBundleFile(file)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger('sidebar-bridge').warn('cannot bridge dsh-better-sidebar: %s', message)
  }

  purgeSidebarModules(ctx)
  ctx.provide('remoteSshSidebarHook', {})

  const remountTimer = setTimeout(() => {
    void remountSidebarIfStale(ctx, patchedThisBoot)
  }, REMOUNT_DELAY_MS)

  ctx.effect(() => () => {
    clearTimeout(remountTimer)
    remembered.clear()
    if (target[GIT_HOOK_SYMBOL] !== gitHook) return
    if (previous.git === undefined) delete target[GIT_HOOK_SYMBOL]
    else target[GIT_HOOK_SYMBOL] = previous.git
    if (previous.list === undefined) delete target[LIST_HOOK_SYMBOL]
    else target[LIST_HOOK_SYMBOL] = previous.list
    if (previous.read === undefined) delete target[READ_HOOK_SYMBOL]
    else target[READ_HOOK_SYMBOL] = previous.read
  }, 'Remote SSH sidebar bridge')
}

/**
 * Source transform: one insertion per stock function entry. The published
 * bundle carries all three functions in one module (`requireAll`); source
 * checkouts carry one each, so those transform opportunistically. A bundle
 * missing any signature has drifted and fails loud rather than silently
 * misbehaving remotely.
 *
 * @returns the transformed source, or undefined when nothing applied.
 */
export function injectSidebarBridge(source: string, requireAll = false): string | undefined {
  if (source.includes(GIT_HOOK_SYMBOL_NAME) || source.includes(LIST_HOOK_SYMBOL_NAME) || source.includes(READ_HOOK_SYMBOL_NAME)) return undefined
  let out = source
  let injected = 0
  if (RUN_GIT_START.test(out)) {
    out = out.replace(RUN_GIT_START, match => match + RUN_GIT_HOOK)
    injected += 1
  }
  if (READ_DIRECTORY_START.test(out)) {
    out = out.replace(READ_DIRECTORY_START, match => match + READ_DIRECTORY_HOOK)
    injected += 1
  }
  if (READ_TEXT_START.test(out)) {
    out = out.replace(READ_TEXT_START, match => match + READ_TEXT_HOOK)
    injected += 1
  }
  if (requireAll && injected < 3) {
    throw new Error('dsh-remote-ssh: stock sidebar function signature changed')
  }
  return injected === 0 ? undefined : out
}

/**
 * The execution world for one sidebar call. The session alias and any remote
 * POSIX path inside a configured workspace route directly; a remote root the
 * bridge itself reported earlier (repository top level above the workspace,
 * linked worktrees, explorer rows in remote space) pins its remembered route
 * — but only when the path does not also exist locally, so a genuinely local
 * session whose cwd spells the same never executes remotely.
 */
export function sidebarBridgeRoute(
  manager: RemoteSshManager,
  remembered: ReadonlyMap<string, RemoteWorkspaceRoute>,
  cwd: string,
): RemoteWorkspaceRoute | undefined {
  const routed = manager.route(undefined, cwd)
  if (routed.kind === 'remote') return routed
  if (!posix.isAbsolute(cwd) && !/^[A-Za-z]:[\\/]/.test(cwd) && !cwd.startsWith('\\\\')) return undefined
  const route = remembered.get(rememberedRootKey(cwd))
  if (route === undefined || existsSync(cwd)) return undefined
  return route
}

/** Fully quoted remote command line; stdout/stderr land in runtime files. */
export function buildRemoteGitCommand(
  root: string,
  args: readonly string[],
  stdoutPath: string,
  stderrPath: string,
  os: RemoteOs = 'posix',
): string {
  if (args.length === 0) throw new Error('dsh-remote-ssh: sidebar git bridge requires at least one git argument')
  const argv = ['-C', root, '--no-pager', '-c', 'color.ui=false', ...args]
  if (os === 'windows') {
    // A .NET process wrapper keeps redirects byte-exact; PowerShell's own `>`
    // would re-encode porcelain output on Windows PowerShell 5.1.
    return buildPowerShellProcessScript({
      fileName: 'git',
      args: argv,
      stdin: { kind: 'eof' },
      stdoutPath: toNativeRemotePath(os, normalizeRemotePath(os, stdoutPath)),
      stderrPath: toNativeRemotePath(os, normalizeRemotePath(os, stderrPath)),
    })
  }
  return `git ${argv.map(quotePosix).join(' ')} < /dev/null > ${quotePosix(stdoutPath)} 2> ${quotePosix(stderrPath)}`
}

/**
 * Run one git invocation on the route's SSH host. The command keeps stock
 * runGit's argv prefix (`-C <root> --no-pager -c color.ui=false`) with the
 * root translated into the workspace's remote POSIX path.
 */
export async function runRemoteGit(
  manager: RemoteSshManager,
  route: RemoteWorkspaceRoute,
  remembered: Map<string, RemoteWorkspaceRoute>,
  cwd: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): Promise<string> {
  const os = routeRemoteOs(route)
  const remoteRoot = toNativeRemotePath(os, normalizeRemotePath(os, route.mapper.toRemotePath(cwd)))
  const [shell, workspace] = await Promise.all([
    manager.workspaceShell(route, manager.remoteDialect(route)),
    manager.workspaceContext(route),
  ])
  const client = await workspace.remote.getClient()
  const token = randomUUID()
  const stdoutPath = posix.join(workspace.remote.runtimeRoot, `sidebar-git-${token}.out`)
  const stderrPath = posix.join(workspace.remote.runtimeRoot, `sidebar-git-${token}.err`)
  const budgetMs = Math.max(Math.floor(timeoutMs ?? STOCK_TIMEOUT_MS), REMOTE_TIMEOUT_FLOOR_MS)
  try {
    const execution = await shell.execute(shell.resolve({
      command: buildRemoteGitCommand(remoteRoot, args, stdoutPath, stderrPath, os),
      workdir: route.aliasPath,
      timeoutMs: budgetMs,
      onExpiry: 'kill',
      env: { GIT_OPTIONAL_LOCKS: '0' },
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: route.aliasPath },
    }))
    const result = await execution.result()
    const [stdout, stderr] = await Promise.all([
      readRemoteResource(client, fileUriFromPosixPath(stdoutPath), STDOUT_MAX_BYTES),
      readRemoteResource(client, fileUriFromPosixPath(stderrPath), STDERR_MAX_BYTES),
    ])
    const stdoutText = stdout.toString('utf8')
    rememberRemoteRoots(remembered, route, args, stdoutText)
    if (result.exitCode === 0) return stdoutText
    const stderrText = stderr.toString('utf8').trim()
    if (result.exitCode === null || result.timedOut || result.aborted) {
      const cause = result.timedOut ? `timed out after ${budgetMs}ms`
        : result.aborted ? 'was aborted'
          : `was killed (${result.signal ?? 'unknown signal'})`
      throw gitCommandError(`git ${args[0] ?? ''} ${cause}${stderrText === '' ? '' : `\n${stderrText}`}`, args)
    }
    // The shell's own diagnostics (git missing on the host, redirection
    // failures) ride the PTY stream, not the stderr file.
    const diagnostic = stderrText || result.stdout.text.trim() || `git exited with ${result.exitCode}`
    throw gitCommandError(diagnostic, args)
  } finally {
    await Promise.allSettled([
      client.resourceDelete({ uri: fileUriFromPosixPath(stdoutPath), recursive: false }),
      client.resourceDelete({ uri: fileUriFromPosixPath(stderrPath), recursive: false }),
    ])
  }
}

/**
 * One explorer level from the remote host: a single AHP `resourceList` per
 * directory (never the N+1 resolve/stat walk) whose rows carry REMOTE POSIX
 * paths — the path space git roots and tool events already use.
 */
export async function listRemoteDirectory(
  manager: RemoteSshManager,
  route: RemoteWorkspaceRoute,
  path: string,
  maxEntries: number,
): Promise<SidebarListing> {
  const os = routeRemoteOs(route)
  const remoteDir = route.mapper.toRemotePath(path)
  const workspace = await manager.workspaceContext(route)
  const client = await workspace.remote.getClient()
  const listed = await client.resourceList({ uri: fileUriFromPosixPath(remoteDir) })
  const sorted = [...listed.entries].sort(compareListingRows)
  const truncated = sorted.length > maxEntries
  const kept = truncated ? sorted.slice(0, maxEntries) : sorted
  return {
    path: toNativeRemotePath(os, remoteDir),
    truncated,
    entries: kept.map(entry => ({
      name: entry.name,
      path: toNativeRemotePath(os, posix.join(remoteDir, entry.name)),
      isDir: entry.type === 'directory',
      // AHP resourceList exposes no symlink bit; stock symlink probing stays
      // a local-stat concern and simply does not apply to remote rows.
      isSymlink: false,
      broken: false,
      hidden: entry.name.startsWith('.'),
    })),
  }
}

/** Stock explorer row order: directories first, then case-insensitive names. */
export function compareListingRows(
  left: { name: string; type?: string },
  right: { name: string; type?: string },
): number {
  const leftDir = left.type === 'directory'
  const rightDir = right.type === 'directory'
  if (leftDir !== rightDir) return leftDir ? -1 : 1
  const ln = left.name.toLowerCase()
  const rn = right.name.toLowerCase()
  if (ln !== rn) return ln < rn ? -1 : 1
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

/**
 * One editor read through the workspace's AHP filesystem, preserving the
 * stock contract: bounded content, `truncated` flag, NUL-probe binary
 * detection with a base64 head for client-side viewer matching.
 */
export async function readRemoteText(
  manager: RemoteSshManager,
  route: RemoteWorkspaceRoute,
  path: string,
  readLimit: number,
): Promise<SidebarRead> {
  const remotePath = route.mapper.toRemotePath(path)
  const fs = (await manager.workspaceContext(route)).fs
  const info = await fs.lstat(remotePath)
  if (info === undefined) throw sidebarFsError(`cannot read "${path}": file not found`)
  if (info.type === 'directory') throw sidebarFsError(`"${path}" is a directory`)
  if (info.type !== 'file') throw sidebarFsError(`cannot read "${path}": not a regular file`)
  const size = info.size ?? 0
  const target = await fs.resolve(remotePath)
  const bytes = size > readLimit
    ? await fs.readByteRange(target, { offset: 0, length: readLimit })
    : await fs.readBytes(target, undefined, readLimit)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const binary = buffer.includes(0)
  return {
    content: binary ? '' : buffer.toString('utf8'),
    truncated: size > readLimit,
    binary,
    size,
    ...(binary ? { head: buffer.subarray(0, Math.min(buffer.length, READ_HEAD_LIMIT)).toString('base64') } : {}),
  }
}

/**
 * Locate the installed dsh-better-sidebar backend bundle. The profile root is
 * the loader's baseUrl; a non-hoisted layout is still reachable through the
 * package's own subpath export, so both are tried.
 */
export function sidebarBundleFile(ctx: Context): string | undefined {
  const root = ctx.baseUrl === undefined ? process.cwd() : fileURLToPath(ctx.baseUrl)
  const candidates: string[] = []
  try {
    const require = createRequire(join(root, 'noop.cjs'))
    candidates.push(require.resolve(`${SIDEBAR_PACKAGE}/lib/index.js`))
  } catch { /* the package usually exports no ./lib subpath */ }
  candidates.push(join(root, 'node_modules', SIDEBAR_PACKAGE, 'lib', 'index.js'))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate)
    } catch { /* try the next layout */ }
  }
  return undefined
}

/**
 * Write the remote-aware branches into the sidebar bundle on disk.
 *
 * Idempotent (an already patched file is left alone), keeps the unpatched
 * original as `<file>.dsh-remote-ssh-bak`, and refuses to touch a bundle whose
 * stock signatures drifted (the caller degrades to stock behavior).
 *
 * @returns true when this call wrote the patch, false when it was already there.
 */
export function patchSidebarBundleFile(file: string): boolean {
  const source = readFileSync(file, 'utf8')
  if (source.includes(GIT_HOOK_SYMBOL_NAME)) return false
  let transformed: string | undefined
  try {
    transformed = injectSidebarBridge(source, true)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`unrecognized dsh-better-sidebar bundle: ${file} (${reason})`, { cause: error })
  }
  if (transformed === undefined) throw new Error(`unrecognized dsh-better-sidebar bundle: ${file}`)
  const backup = `${file}.dsh-remote-ssh-bak`
  if (!existsSync(backup)) writeFileSync(backup, source)
  const tmp = `${file}.dsh-remote-ssh-tmp-${String(process.pid)}`
  writeFileSync(tmp, transformed)
  renameSync(tmp, file)
  return true
}

/**
 * Record repository roots the bridge itself observed, so later sidebar calls
 * that pass those roots back (status on the discovered root, worktree
 * selection, explorer rows) resolve the same remote world even when the root
 * sits above the configured workspace path.
 */
export function rememberRemoteRoots(
  remembered: Map<string, RemoteWorkspaceRoute>,
  route: RemoteWorkspaceRoute,
  args: readonly string[],
  stdout: string,
): void {
  const os = routeRemoteOs(route)
  const roots: string[] = []
  if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
    roots.push(...stdout.split('\n').map(line => line.trim()))
  } else if (args[0] === 'worktree' && args[1] === 'list') {
    for (const record of stdout.split('\0')) {
      if (record.startsWith('worktree ')) roots.push(record.slice('worktree '.length).trim())
    }
  }
  for (const root of roots) {
    // Windows git prints drive paths with forward slashes (`C:/repos/x`);
    // both spellings must land on the same remembered key.
    if (isRemoteAbsolutePath(os, root)) rememberRoot(remembered, root, route)
  }
}

/** Purge any cached sidebar module so its next import meets the transform. */
export function purgeSidebarModules(ctx: Context): void {
  for (const url of ctx.loader.internal?.loadCache.keys() ?? []) {
    if (!isSidebarPackageModule(url)) continue
    ctx.loader.internal?.loadCache.delete(url)
  }
}

/**
 * Entries start concurrently; when the sidebar's import still won the race
 * (transform never fired), purge the cached module and restart its entry so
 * the re-import flows through the armed hook. Best-effort and logged: an
 * unexpected loader shape degrades to a warning, never a crash.
 */
export async function remountSidebarIfStale(ctx: Context, patchedThisBoot: boolean): Promise<void> {
  const internal = ctx.loader.internal
  if (internal === undefined) return
  // A bundle patched in an earlier boot is what every import of this boot
  // already read; only a patch written just now can have lost the race with
  // an import that happened before it.
  if (!patchedThisBoot) return
  const loaded = [...internal.loadCache.keys()].filter(isSidebarPackageModule)
  if (loaded.length === 0) return
  const entry = [...ctx.loader.entries()].find(candidate =>
    candidate.options.name === SIDEBAR_PACKAGE && !candidate.disabled)
  if (entry === undefined || typeof entry._dispose !== 'function' || typeof entry.init !== 'function') {
    ctx.logger('sidebar-bridge').warn('dsh-better-sidebar loaded before the Remote SSH bridge; restart the profile to activate it')
    return
  }
  try {
    // Let a boot-time import that is still in flight settle before the cache
    // is purged; starting a second instance instead (init on a running entry)
    // conflicts with the live routes.
    const pending = (entry as unknown as { _initTask?: Promise<unknown> })._initTask
    if (pending !== undefined) {
      await withTimeout(pending.catch(() => {}), REMOUNT_SETTLE_TIMEOUT_MS, 'in-flight entry init')
    }
    for (const url of loaded) internal.loadCache.delete(url)
    await entry._dispose()
    await withTimeout(entry.init(), REMOUNT_SETTLE_TIMEOUT_MS, 'entry re-init')
    ctx.logger('sidebar-bridge').info('remounted %s with the Remote SSH bridge active', SIDEBAR_PACKAGE)
  } catch (error: unknown) {
    ctx.logger('sidebar-bridge').warn('failed to remount %s: %s', SIDEBAR_PACKAGE, error instanceof Error ? error.message : String(error))
  }
}

/** Bound one self-heal step so a stuck loader can never wedge the boot. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => {
          rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Canonical remembered-root key: internal form, case-folded for NTFS remotes. */
function rememberedRootKey(root: string): string {
  const os: RemoteOs = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\') || /^\/[A-Za-z]:/.test(root) || root.startsWith('//') ? 'windows' : 'posix'
  return remotePathKey(os, root)
}

function rememberRoot(remembered: Map<string, RemoteWorkspaceRoute>, root: string, route: RemoteWorkspaceRoute): void {
  const key = rememberedRootKey(root)
  remembered.delete(key)
  remembered.set(key, route)
  while (remembered.size > REMEMBERED_ROOT_LIMIT) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

/** The injected branches never throw synchronously into stock callers. */
function wrapHook<T>(invoke: () => Promise<T> | undefined): Promise<T> | undefined {
  try {
    return invoke()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * dsh-better-sidebar surfaces non-SidebarError throws as wire code 'internal'
 * with the message — identical to its stock GitCommandError — and never
 * instanceof-checks the class, so this duck-typed error is indistinguishable
 * on every path that matters.
 */
function gitCommandError(message: string, args: readonly string[]): Error {
  return Object.assign(new Error(message), { code: 'git-error', command: args.join(' ') })
}

/** Same duck-typing rationale as {@link gitCommandError} for fs failures. */
function sidebarFsError(message: string): Error {
  return Object.assign(new Error(message), { code: 'fs-error' })
}

/** Read one redirect file; a missing file means the command never started. */
async function readRemoteResource(client: AhpClient, uri: string, maxBytes: number): Promise<Buffer> {
  try {
    const result = await client.resourceRead({ uri, encoding: BASE64 })
    const raw = result.encoding === BASE64 ? Buffer.from(result.data, 'base64') : Buffer.from(result.data, 'utf8')
    return raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw
  } catch {
    return Buffer.alloc(0)
  }
}

function normalizedModuleUrl(url: string): string {
  const decoded = decodeURIComponent(url).replaceAll('\\', '/')
  const query = decoded.indexOf('?')
  return query === -1 ? decoded : decoded.slice(0, query)
}

function isSidebarPackageModule(url: string): boolean {
  return normalizedModuleUrl(url).includes(`/${SIDEBAR_PACKAGE}/`)
}

export default apply
