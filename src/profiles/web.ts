import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RemoteOpenFileMode, RemoteSshManager, RemoteSshServer } from '../routing/manager.ts'
import { openRemoteFile } from '../ssh/open-file.ts'
import { appendSshHost, defaultSshConfigFiles, discoverSshConfigHosts } from '../ssh/config.ts'

export const REMOTE_SSH_STATE_PATH = '/plugins/dsh-remote-ssh/state'
export const REMOTE_SSH_LINK_STATE_PATH = '/plugins/dsh-remote-ssh/link-state'
export const REMOTE_SSH_LINK_STATE_STREAM_PATH = '/plugins/dsh-remote-ssh/link-state/stream'
export const REMOTE_SSH_SERVER_PATH = '/plugins/dsh-remote-ssh/server'
export const REMOTE_SSH_SERVER_REMOVE_PATH = '/plugins/dsh-remote-ssh/server/remove'
export const REMOTE_SSH_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/workspace'
export const REMOTE_SSH_WORKSPACE_REMOVE_PATH = '/plugins/dsh-remote-ssh/workspace/remove'
export const REMOTE_SSH_LOCAL_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/local-workspace'
export const REMOTE_SSH_PROBE_PATH = '/plugins/dsh-remote-ssh/probe'
export const REMOTE_SSH_CONFIG_HOST_PATH = '/plugins/dsh-remote-ssh/ssh-config/host'
export const REMOTE_SSH_SETTINGS_PATH = '/plugins/dsh-remote-ssh/settings'
export const REMOTE_SSH_DIRECTORY_PATH = '/plugins/dsh-remote-ssh/directory'
export const REMOTE_SSH_OPEN_FILE_PATH = '/plugins/dsh-remote-ssh/open-file'

export const name = 'dsh-remote-ssh-web'
export const inject = ['remoteSshManager']

/** Activate the Web surface only in compositions that provide a Web host. */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], registerWebRoutes)
}

/** Register same-origin catalog mutation and connection-probe endpoints. */
function registerWebRoutes(ctx: Context): void {
  /** Long-lived link-state streams, ended when these routes are torn down. */
  const linkStreams = new Set<ServerResponse>()
  const routes = [
    route(ctx, REMOTE_SSH_STATE_PATH, 'GET', async (_req, res) => {
      json(res, 200, await catalogState(ctx.remoteSshManager))
    }),
    route(ctx, REMOTE_SSH_LINK_STATE_PATH, 'GET', async (_req, res) => {
      json(res, 200, { workspaces: ctx.remoteSshManager.workspaceLinkStates() })
    }),
    route(ctx, REMOTE_SSH_LINK_STATE_STREAM_PATH, 'GET', async (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      const send = (): void => {
        if (res.writableEnded) return
        res.write(`${JSON.stringify({ workspaces: ctx.remoteSshManager.workspaceLinkStates() })}\n`)
      }
      const detach = ctx.remoteSshManager.onLinkStateChange(send)
      linkStreams.add(res)
      send()
      try {
        await new Promise<void>(resolvePromise => { res.once('close', resolvePromise) })
      } finally {
        detach()
        linkStreams.delete(res)
      }
    }),
    route(ctx, REMOTE_SSH_SETTINGS_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const sshConfigFile = optionalString(body, 'sshConfigFile')
      const openFileEditorPath = optionalString(body, 'openFileEditorPath')
      const openFileMode = body.openFileMode === undefined ? undefined : parseOpenFileMode(body.openFileMode)
      await ctx.remoteSshManager.updateUserPreferences({
        ...(sshConfigFile === undefined ? {} : { sshConfigFile }),
        ...(openFileMode === undefined ? {} : { openFileMode }),
        ...(openFileEditorPath === undefined ? {} : { openFileEditorPath }),
      })
      const snapshot = ctx.remoteSshManager.snapshot()
      json(res, 200, {
        sshConfigFile: snapshot.sshConfigFile,
        openFileMode: snapshot.openFileMode,
        openFileEditorPath: snapshot.openFileEditorPath,
      })
    }),
    route(ctx, REMOTE_SSH_DIRECTORY_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const path = body.path
      if (path !== undefined && typeof path !== 'string') throw new Error('path must be a string')
      json(res, 200, await ctx.remoteSshManager.listRemoteDirectory(server, path as string | undefined))
    }),
    route(ctx, REMOTE_SSH_OPEN_FILE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, await openRemoteFile(
        ctx.remoteSshManager,
        requiredString(body, 'workspaceId'),
        requiredString(body, 'path'),
      ))
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'serverId'))
      const remoteOs = parseRemoteOs(body.remoteOs)
      const configured = ctx.remoteSshManager.snapshot().servers.find(candidate => candidate.id === server.id)
        ?? await ctx.remoteSshManager.addServer({
          id: server.id,
          label: server.label,
          sshTarget: server.sshTarget,
          ...(remoteOs === undefined ? {} : { remoteOs }),
        })
      const created = await ctx.remoteSshManager.addWorkspace(configured.id, requiredString(body, 'remotePath'))
      json(res, 201, { id: created.workspace.id, aliasPath: created.aliasPath })
    }),
    route(ctx, REMOTE_SSH_WORKSPACE_REMOVE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { removed: await ctx.remoteSshManager.removeWorkspace(requiredString(body, 'id')) })
    }),
    route(ctx, REMOTE_SSH_LOCAL_WORKSPACE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      json(res, 200, { path: await ctx.remoteSshManager.adoptLocalWorkspace(requiredString(body, 'path')) })
    }),
    route(ctx, REMOTE_SSH_PROBE_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const server = await resolveAvailableServer(ctx.remoteSshManager, requiredString(body, 'id'))
      json(res, 200, await probeServer(server.sshTarget, server.sshArgs ?? []))
    }),
    route(ctx, REMOTE_SSH_CONFIG_HOST_PATH, 'POST', async (req, res) => {
      const body = await readJson(req)
      const configPath = resolve(requiredString(body, 'configPath'))
      const allowed = activeConfigFiles(ctx.remoteSshManager)
      if (!allowed.some(candidate => samePath(candidate, configPath))) throw new Error('selected SSH config file is not active')
      json(res, 201, await appendSshHost(configPath, requiredString(body, 'command')))
    }),
  ]
  ctx.effect(() => () => {
    for (const dispose of routes) dispose()
    for (const stream of linkStreams) if (!stream.writableEnded) stream.end()
    linkStreams.clear()
  }, 'Remote SSH Web routes')
}

interface AvailableServer extends RemoteSshServer {
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
}

async function catalogState(manager: RemoteSshManager) {
  const snapshot = manager.snapshot()
  const configFiles = activeConfigFiles(manager)
  const discovery = await discoverSshConfigHosts(configFiles)
  const servers: AvailableServer[] = snapshot.servers.map(server => ({ ...server, source: 'saved' }))
  for (const discovered of discovery.hosts) {
    const configured = servers.find(server => server.sshTarget === discovered.sshTarget)
    if (configured === undefined) servers.push({ ...discovered, source: 'ssh-config' })
    else Object.assign(configured, {
      source: 'ssh-config' as const,
      configPath: discovered.configPath,
      ...(discovered.hostName === undefined ? {} : { hostName: discovered.hostName }),
      ...(discovered.user === undefined ? {} : { user: discovered.user }),
      ...(discovered.port === undefined ? {} : { port: discovered.port }),
    })
  }
  return {
    servers,
    workspaces: snapshot.workspaces.map(workspace => ({ ...workspace, aliasPath: manager.workspace(workspace.id).aliasPath })),
    serverCount: servers.length,
    discoveredServerCount: discovery.hosts.length,
    workspaceCount: snapshot.workspaces.length,
    configFiles,
    loadedConfigFiles: discovery.files,
    configErrors: discovery.errors,
    customConfigFile: snapshot.sshConfigFile,
    openFileMode: snapshot.openFileMode,
    openFileEditorPath: snapshot.openFileEditorPath,
  }
}

async function resolveAvailableServer(manager: RemoteSshManager, id: string): Promise<RemoteSshServer> {
  const state = await catalogState(manager)
  const server = state.servers.find(candidate => candidate.id === id)
  if (server === undefined) throw new Error('SSH host is no longer present in the active config')
  return server
}

function activeConfigFiles(manager: RemoteSshManager): string[] {
  const custom = manager.snapshot().sshConfigFile
  return custom === undefined || custom.trim() === '' ? defaultSshConfigFiles() : [resolve(custom)]
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

function route(
  ctx: Context,
  path: string,
  method: string,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): () => void {
  return ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req, res) => {
      if (req.method !== method) return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        await handler(req, res)
      } catch (error: unknown) {
        if (!res.headersSent) json(res, 400, { error: safeMessage(error) })
        else if (!res.writableEnded) res.end()
      }
    },
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('request body exceeds 64 KiB')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function parseOpenFileMode(value: unknown): RemoteOpenFileMode {
  if (value === 'auto' || value === 'vscode' || value === 'cursor' || value === 'windsurf'
    || value === 'vscodium' || value === 'custom' || value === 'download') return value
  throw new Error('openFileMode is invalid')
}

function parseRemoteOs(value: unknown): 'posix' | 'windows' | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'posix' || value === 'windows') return value
  throw new Error('remoteOs must be "posix" or "windows"')
}

function trustedRequest(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (host === undefined || origin === undefined) return origin === undefined
  try { return new URL(origin).host === new URL(`http://${host}`).host } catch { return false }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

async function probeServer(sshTarget: string, sshArgs: string[]): Promise<{
  reachable: boolean
  hostname?: string
  os?: 'posix' | 'windows'
  commands?: Record<string, boolean>
  error?: string
}> {
  // Stage one keeps the fast POSIX path; a Windows sshd (cmd or powershell
  // DefaultShell) cannot run it, so stage two re-probes through an explicit
  // Windows PowerShell invocation that works under any default shell.
  const posix = await runProbe(sshTarget, sshArgs, buildPosixProbeCommand())
  if (posix !== undefined && posix.hostname !== undefined) return { reachable: true, ...posix }
  const windows = await runProbe(sshTarget, sshArgs, buildWindowsProbeCommand())
  if (windows !== undefined && windows.hostname !== undefined) return { reachable: true, ...windows }
  if (posix !== undefined) return { reachable: false, ...(posix.error === undefined ? {} : { error: posix.error }) }
  return { reachable: false, ...(windows?.error === undefined ? {} : { error: windows.error }) }
}

/** Facts command for POSIX remotes: hostname, OS, and tool availability. */
export function buildPosixProbeCommand(): string {
  return 'printf "hostname=%s\\n" "$(hostname)"; printf "os=%s\\n" "$(uname -s 2>/dev/null || echo POSIX)"; for dsh_cmd in bash pwsh rg code; do if command -v "$dsh_cmd" >/dev/null 2>&1; then printf "%s=1\\n" "$dsh_cmd"; else printf "%s=0\\n" "$dsh_cmd"; fi; done'
}

/** Facts command for Windows remotes, encoded to survive any DefaultShell. */
export function buildWindowsProbeCommand(): string {
  const script = [
    'Write-Output ("hostname=" + $env:COMPUTERNAME)',
    'Write-Output "os=Windows_NT"',
    "foreach ($dsh_cmd in @('pwsh','powershell','rg','code','bash')) {",
    '  $found = [bool](Get-Command $dsh_cmd -ErrorAction SilentlyContinue)',
    '  Write-Output ("{0}={1}" -f $dsh_cmd, [int]$found)',
    '}',
  ].join('\n')
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/** Run one probe command and parse `key=value` facts; undefined means SSH failed. */
async function runProbe(sshTarget: string, sshArgs: string[], command: string): Promise<{
  hostname?: string
  os?: 'posix' | 'windows'
  commands?: Record<string, boolean>
  error?: string
} | undefined> {
  const child = spawn('ssh', [...sshArgs, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshTarget, command], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
  const timer = setTimeout(() => { child.kill() }, 8_000)
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  }).finally(() => { clearTimeout(timer) })
  if (code !== 0) {
    return { error: Buffer.concat(stderr).toString('utf8').trim().slice(0, 500) || `ssh exit ${code}` }
  }
  const facts = Object.fromEntries(Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/).map(line => line.split('=', 2) as [string, string]))
  return {
    ...(facts.hostname === undefined ? {} : { hostname: facts.hostname }),
    ...(facts.os === 'Windows_NT' ? { os: 'windows' as const } : facts.os !== undefined ? { os: 'posix' as const } : {}),
    commands: Object.fromEntries(['bash', 'pwsh', 'powershell', 'rg', 'code'].map(name => [name, facts[name] === '1'])),
  }
}
