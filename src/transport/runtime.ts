import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ahpProtocolMismatch, DSH_AHP_PROTOCOL_VERSIONS, formatAhpProtocolMismatch } from './ahp-compat.ts'

export interface Config {
  sshTarget: string
  remoteWorkspace?: string
  localWorkspace?: string
  remoteAccessRoot?: string
  sshExecutable?: string
  sshArgs?: string[]
  remoteCodeCommand?: string
  remoteRuntimeRoot?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  protocolVersions?: string[]
  directUrl?: string
}

interface ResolvedConfig extends Config {
  sshExecutable: string
  sshArgs: string[]
  remoteCodeCommand: string
  remoteRuntimeRoot: string
  startupTimeoutMs: number
  requestTimeoutMs: number
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
  protocolVersions: string[]
}

export interface AhpConnection {
  client: AhpClient
  protocolVersion: string
  defaultDirectory?: string
}

/**
 * Pushed view of the shared Agent Host link. `connecting` has not observed a
 * failure yet (first attempt or a consumer-driven refresh), `reconnecting`
 * follows an observed death and covers every backoff retry, and `failed` is
 * a first-time attempt that gave up with no recovery loop running. Map to a
 * traffic light the way the environment status does: yellow, green, red,
 * red, gray.
 */
export type RemoteSshLinkState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disposed'

export interface RemoteSshLinkEvent {
  readonly state: RemoteSshLinkState
  /** Human-readable cause of the latest failure, when one is known. */
  readonly error?: string
}

export type RemoteSshLinkListener = (event: RemoteSshLinkEvent) => void

export function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('remote command arguments cannot contain NUL bytes')
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** Build the POSIX bootstrap that resolves the VS Code CLI and starts Agent Host. */
export function buildRemoteAgentHostCommand(remoteCodeCommand: string): string {
  const requested = quotePosix(remoteCodeCommand)
  return [
    `dsh_code=${requested}`,
    'if [ "$dsh_code" = code ] && ! command -v "$dsh_code" >/dev/null 2>&1 && [ -x "$HOME/.dsh-remote-ssh/cli/bin/code" ]; then dsh_code="$HOME/.dsh-remote-ssh/cli/bin/code"; fi',
    'if ! command -v "$dsh_code" >/dev/null 2>&1; then printf \'dsh-remote-ssh: VS Code CLI not found: %s\\n\' "$dsh_code" >&2; exit 127; fi',
    'exec "$dsh_code" agent host --host 127.0.0.1 --port 0 --idle-timeout 60 --server-data-dir "$HOME/.dsh-remote-ssh/server" --cli-data-dir "$HOME/.dsh-remote-ssh/cli" --verbose',
  ].join('\n')
}

/** List installed VS Code Server entrypoints newest-first for compatibility probing. */
export function buildListEmbeddedAgentHostsCommand(): string {
  return 'find "$HOME/.vscode-server/cli/servers" -type f -path \'*/server/bin/code-server\' -perm -u+x -printf \'%T@ %p\\n\' 2>/dev/null | sort -nr | cut -d \' \' -f 2-'
}

/**
 * Transport-level keepalive shared by every SSH session the runtime opens.
 * Without it, a silently black-holed path leaves one-shot command sessions
 * hanging until `startupTimeoutMs` (default 600s) instead of failing after
 * roughly interval × count.
 */
export const SSH_KEEPALIVE_ARGS: readonly string[] = [
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
]

/** Args of one short-lived `ssh -T` command session: startup, probes, token reads. */
export function buildSshCommandArgs(
  sshArgs: readonly string[],
  sshTarget: string,
  command: string,
): string[] {
  return [...sshArgs, ...SSH_KEEPALIVE_ARGS, '-T', sshTarget, command]
}

/** Build the fallback bootstrap for a VS Code Server installation left by Remote - SSH. */
export function buildEmbeddedAgentHostCommand(codeServerPath?: string, instanceId = 'default'): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(instanceId)) throw new Error(`invalid embedded Agent Host instance id: ${instanceId}`)
  const resolveCodeServer = codeServerPath === undefined
    ? `dsh_code_server=$(${buildListEmbeddedAgentHostsCommand()} | head -n 1)`
    : `dsh_code_server=${quotePosix(codeServerPath)}`
  return [
    resolveCodeServer,
    'if [ -z "$dsh_code_server" ]; then printf \'dsh-remote-ssh: no usable code agent host or VS Code Server code-server found\\n\' >&2; exit 127; fi',
    `exec "$dsh_code_server" --host 127.0.0.1 --port 0 --agent-host-port 0 --accept-server-license-terms --server-data-dir "$HOME/.dsh-remote-ssh/server-embedded/${instanceId}" --log info`,
  ].join('\n')
}

export function fileUriFromPosixPath(path: string): string {
  if (!posix.isAbsolute(path)) throw new Error(`remote path must be absolute: ${path}`)
  return `file://${path.split('/').map(part => encodeURIComponent(part)).join('/')}`
}

export function posixPathFromFileUri(uri: string): string {
  const parsed = new URL(uri)
  if (parsed.protocol !== 'file:' || (parsed.hostname !== '' && parsed.hostname !== 'localhost')) {
    throw new Error(`expected a local file URI from Agent Host, received ${uri}`)
  }
  const path = decodeURIComponent(parsed.pathname)
  if (!posix.isAbsolute(path)) throw new Error(`Agent Host returned a non-absolute file URI: ${uri}`)
  return posix.normalize(path)
}

export class WorkspacePathMapper {
  readonly localWorkspace: string
  readonly remoteWorkspace: string

  constructor(localWorkspace: string, remoteWorkspace: string) {
    this.localWorkspace = resolve(localWorkspace)
    this.remoteWorkspace = posix.normalize(remoteWorkspace)
    if (!isAbsolute(this.localWorkspace)) throw new Error('localWorkspace must be an absolute local path')
    if (!posix.isAbsolute(this.remoteWorkspace)) {
      throw new Error(`remoteWorkspace must be an absolute POSIX path: ${remoteWorkspace}`)
    }
  }

  toRemotePath(input: string, cwd?: string): string {
    if (input.trim().length === 0) throw new Error('path must be a non-empty string')
    if (input.startsWith('file:')) return posixPathFromFileUri(input)

    const localAbsolute = isAbsolute(input)
    if (localAbsolute) {
      const rel = relative(this.localWorkspace, resolve(input))
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
        return posix.resolve(this.remoteWorkspace, rel.split(sep).join('/'))
      }
      // On POSIX, local and remote absolute paths share the same syntax. Paths
      // outside the alias are therefore remote; Windows local paths remain
      // distinguishable and must not escape the alias.
      if (input.startsWith('/')) return posix.normalize(input)
      throw new Error(`local path is outside the Remote SSH workspace alias: ${input}`)
    }

    if (input.startsWith('/')) return posix.normalize(input)

    const base = cwd === undefined ? this.remoteWorkspace : this.toRemotePath(cwd)
    return posix.resolve(base, input.replaceAll('\\', '/'))
  }

}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSsh: RemoteSshRuntime
  }
}

export class RemoteSshRuntime extends Service {
  static Config: z<Config> = z.object({
    sshTarget: z.string().required(),
    remoteWorkspace: z.string(),
    localWorkspace: z.string(),
    remoteAccessRoot: z.string(),
    sshExecutable: z.string().default('ssh'),
    sshArgs: z.array(z.string()).default([]),
    remoteCodeCommand: z.string().default('code'),
    remoteRuntimeRoot: z.string().default('/tmp/dsh-remote-ssh'),
    startupTimeoutMs: z.number().default(600_000),
    requestTimeoutMs: z.number().default(30_000),
    heartbeatIntervalMs: z.number().default(30_000),
    heartbeatTimeoutMs: z.number().default(60_000),
    reconnectInitialDelayMs: z.number().default(500),
    reconnectMaxDelayMs: z.number().default(10_000),
    protocolVersions: z.array(z.string()).default([...DSH_AHP_PROTOCOL_VERSIONS]),
    directUrl: z.string(),
  })

  readonly mapper: WorkspacePathMapper | undefined
  readonly config: ResolvedConfig
  readonly clientId = `dsh-remote-ssh-${randomUUID()}`
  readonly runtimeRoot: string
  readonly remoteAccessRoot: string

  /**
   * The current connection attempt. Replaced whenever the Agent Host link is
   * known to be gone: the previous Agent Host tunnel is a single physical SSH
   * session, so a dropped link must be reopened instead of being served
   * forever from a cache.
   */
  private connection: Promise<AhpConnection> | undefined
  private tunnel: ChildProcessWithoutNullStreams | undefined
  private embeddedAgentHost: ChildProcessWithoutNullStreams | undefined
  /** Client of the settled {@link connection}, used to judge liveness. */
  private live: AhpClient | undefined
  /** Set once the current connection is known dead and must be reopened. */
  private stale = false
  /** Connection-attempt counter; one remote Host instance per attempt. */
  private generation = 0
  /** Periodic protocol-level liveness probe of {@link live}; see {@link startHeartbeat}. */
  private heartbeatTimer: NodeJS.Timeout | undefined
  /** Guards against stacking probes while one awaits its pong deadline. */
  private heartbeatInFlight = false
  /** The running background recovery loop; see {@link reconnectInBackground}. */
  private recoveryLoop: Promise<void> | undefined
  /** Aborted on dispose so a sleeping recovery loop exits promptly. */
  private readonly recoveryAbort = new AbortController()
  /** Pushed link state; see {@link onStateChange}. */
  private linkState: RemoteSshLinkState = 'connecting'
  private linkError: string | undefined
  private readonly linkListeners = new Set<RemoteSshLinkListener>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'remoteSsh')
    this.config = config as ResolvedConfig
    if ((config.localWorkspace === undefined) !== (config.remoteWorkspace === undefined)) {
      throw new Error('dsh-remote-ssh: localWorkspace and remoteWorkspace must be configured together')
    }
    this.mapper = config.localWorkspace === undefined || config.remoteWorkspace === undefined
      ? undefined
      : new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace)
    this.remoteAccessRoot = posix.normalize(config.remoteAccessRoot ?? config.remoteWorkspace ?? '/')
    this.runtimeRoot = posix.join(this.config.remoteRuntimeRoot, this.clientId)
    this.validate()
    if (this.mapper !== undefined) mkdirSync(this.mapper.localWorkspace, { recursive: true })
    this.begin()
    ctx.effect(() => async () => {
      this.disposed = true
      this.stopHeartbeat()
      this.recoveryAbort.abort(new Error('dsh-remote-ssh: Remote SSH service disposed'))
      this.publishState('disposed')
      const pending = this.connection
      this.connection = undefined
      this.live = undefined
      try {
        if (pending !== undefined) await (await pending).client.shutdown()
      } catch {
        // A failed startup owns its original diagnostic.
      } finally {
        this.tunnel?.kill()
        this.embeddedAgentHost?.kill()
      }
    }, 'Remote SSH AHP teardown')
  }

  /**
   * Whether the Agent Host link is usable. A host runtime whose link died must
   * be discarded by its owner instead of being reused, so cached consumers
   * (workspace fs/shell contexts) do not keep failing on a closed client.
   * A connection still starting or still being retried reads as connected.
   */
  get connected(): boolean {
    if (this.disposed || this.stale) return false
    return this.live === undefined || this.live.connectionState.status !== 'closed'
  }

  /** Current pushed link state; the pull counterpart of {@link onStateChange}. */
  get state(): RemoteSshLinkState {
    return this.linkState
  }

  /**
   * Subscribe to link state transitions. The current state is not replayed;
   * poll {@link state} after subscribing. Listener errors are swallowed so a
   * broken consumer cannot take the link down with it.
   */
  onStateChange(listener: RemoteSshLinkListener): () => void {
    this.linkListeners.add(listener)
    return () => { this.linkListeners.delete(listener) }
  }

  /** Publish a state transition, skipping no-op republishes. */
  private publishState(state: RemoteSshLinkState, error?: string): void {
    if (this.linkState === state && this.linkError === error) return
    this.linkState = state
    this.linkError = error
    const event: RemoteSshLinkEvent = error === undefined ? { state } : { state, error }
    for (const listener of [...this.linkListeners]) {
      try { listener(event) } catch { /* a broken consumer must not affect the link */ }
    }
  }

  /**
   * Resolve the shared connection, reopening it when the previous one is gone.
   * Concurrent callers share one attempt, and a link that closes while a caller
   * waits for it produces a fresh attempt rather than a `ClientClosedError`.
   */
  async getConnection(): Promise<AhpConnection> {
    if (this.disposed) throw new Error('Remote SSH service is disposing')
    for (let attempt = 0; ; attempt += 1) {
      const pending = this.connection ?? this.begin()
      let connection: AhpConnection
      try {
        connection = await pending
      } catch (error: unknown) {
        if (this.connection === pending) this.connection = undefined
        throw error
      }
      if (this.disposed) throw new Error('Remote SSH service is disposing')
      if (this.usable(connection)) return connection
      if (this.connection === pending) this.retire()
      if (attempt >= 1) throw new Error('dsh-remote-ssh: the remote Agent Host connection closed again immediately after reconnecting')
    }
  }

  async getClient(): Promise<AhpClient> {
    return (await this.getConnection()).client
  }

  /**
   * Drop the current connection so the next call must open a fresh one. Used
   * by idempotent reads that raced a link change between client hand-out and
   * request delivery; the dead tunnel is torn down with it.
   */
  invalidateConnection(): void {
    if (this.disposed) return
    this.retire()
  }

  /** Queue one connection attempt and attach its liveness watchers. */
  private begin(): Promise<AhpConnection> {
    // A retry inside the recovery loop stays 'reconnecting'; every other
    // attempt (first open, consumer-driven refresh after invalidation) reads
    // as a plain start.
    if (this.linkState !== 'reconnecting') this.publishState('connecting')
    const pending = this.open().then(connection => {
      if (this.connection !== pending) return connection
      this.live = connection.client
      this.stale = false
      this.watch(connection)
      this.startHeartbeat(connection.client)
      this.publishState('connected')
      return connection
    })
    this.connection = pending
    void pending.catch(error => {
      if (this.connection !== pending) return
      this.connection = undefined
      const message = errorMessage(error)
      if (this.linkState === 'reconnecting') this.publishState('reconnecting', message)
      else this.publishState('failed', message)
    })
    return pending
  }

  private usable(connection: AhpConnection): boolean {
    if (this.stale) return false
    if (this.live !== undefined && this.live !== connection.client) return false
    return connection.client.connectionState.status !== 'closed'
  }

  private retire(): void {
    const pending = this.connection
    this.connection = undefined
    this.live = undefined
    this.stale = false
    this.stopHeartbeat()
    void pending?.catch(() => {})
    this.tunnel?.kill()
    this.tunnel = undefined
    this.embeddedAgentHost?.kill()
    this.embeddedAgentHost = undefined
  }

  /**
   * Watch the link for closure. The AHP client publishes its own state, and an
   * SSHD-side disconnect also kills the tunnel child; either one marks this
   * runtime stale so the next call reconnects instead of failing the turn.
   */
  private watch(connection: AhpConnection): void {
    const client = connection.client
    void (async () => {
      try {
        for await (const state of client.stateChanges()) {
          if (state.status === 'closed') break
        }
      } catch {
        // A terminated transition stream is itself a closure signal.
      }
      if (this.live === client) this.markStale()
    })()
  }

  private markStale(): void {
    if (this.disposed || this.stale) return
    this.stale = true
    this.publishState('reconnecting')
    this.reconnectInBackground()
  }

  /**
   * Heal a dead link without waiting for the next consumer request. The
   * shared single-flight attempt means a concurrent consumer call joins the
   * same recovery instead of racing a private one; a consumer call during a
   * backoff sleep attempts immediately and the loop adopts its result when it
   * wakes. Failed bootstraps retry with exponential backoff and jitter,
   * reset by every success.
   */
  private reconnectInBackground(): void {
    if (this.recoveryLoop !== undefined) return
    const loop = this.runRecoveryLoop().finally(() => {
      if (this.recoveryLoop === loop) this.recoveryLoop = undefined
    })
    this.recoveryLoop = loop
    void loop.catch(() => undefined)
  }

  private async runRecoveryLoop(): Promise<void> {
    let delayMs = 0
    for (;;) {
      if (this.disposed) return
      if (delayMs > 0) {
        try {
          await delay(jitter(delayMs), this.recoveryAbort.signal)
        } catch {
          return
        }
        if (this.disposed) return
      }
      try {
        await this.getConnection()
        return
      } catch (error) {
        if (this.disposed) return
        // begin() already published the diagnostic; republish only when the
        // recovery loop is the sole observer of this failure.
        this.publishState('reconnecting', errorMessage(error))
        const initialMs = this.config.reconnectInitialDelayMs
        const maxMs = Math.max(initialMs, this.config.reconnectMaxDelayMs)
        delayMs = delayMs === 0 ? initialMs : Math.min(maxMs, delayMs * 2)
      }
    }
  }

  /**
   * Probe the settled link with the protocol-level `ping` command. The SSH
   * keepalive covers a dead transport; this additionally catches a wedged
   * Agent Host behind a live tunnel and complements the client's own
   * close-state publication, which cannot fire on a half-open path.
   */
  private startHeartbeat(client: AhpClient): void {
    this.stopHeartbeat()
    const intervalMs = this.config.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => { void this.probeHeartbeat(client) }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private async probeHeartbeat(client: AhpClient): Promise<void> {
    // One outstanding probe at a time: a link slow enough to still owe a pong
    // gets no second ping until it answers or misses the deadline.
    if (this.disposed || this.live !== client || this.stale || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      await withDeadline(client.ping(), this.config.heartbeatTimeoutMs, 'dsh-remote-ssh: Agent Host heartbeat timed out')
    } catch {
      // The link may have been replaced while the probe was in flight; the
      // timer and the stale flag then belong to the new link, not this one.
      if (this.disposed || this.live !== client) return
      // Stop probing once the link is declared dead; teardown and reopening
      // stay owned by the shared connection attempt so consumers race one
      // recovery instead of a private one.
      this.stopHeartbeat()
      this.markStale()
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /** Workspace mapper for the legacy single-workspace providers. */
  getMapper(): WorkspacePathMapper {
    if (this.mapper === undefined) throw new Error('dsh-remote-ssh: this shared host runtime has no default workspace mapper')
    return this.mapper
  }

  private validate(): void {
    const { sshTarget, sshExecutable, remoteCodeCommand, remoteRuntimeRoot, startupTimeoutMs, requestTimeoutMs, protocolVersions } = this.config
    if (sshTarget.trim().length === 0 && this.config.directUrl === undefined) {
      throw new Error('dsh-remote-ssh: sshTarget must be non-empty')
    }
    if (sshExecutable.trim().length === 0) throw new Error('dsh-remote-ssh: sshExecutable must be non-empty')
    if (remoteCodeCommand.trim().length === 0) throw new Error('dsh-remote-ssh: remoteCodeCommand must be non-empty')
    if (!posix.isAbsolute(remoteRuntimeRoot)) throw new Error('dsh-remote-ssh: remoteRuntimeRoot must be an absolute POSIX path')
    if (!posix.isAbsolute(this.remoteAccessRoot)) throw new Error('dsh-remote-ssh: remoteAccessRoot must be an absolute POSIX path')
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
      throw new Error('dsh-remote-ssh: startupTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('dsh-remote-ssh: requestTimeoutMs must be a positive integer')
    }
    const { heartbeatIntervalMs, heartbeatTimeoutMs } = this.config
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
      throw new Error('dsh-remote-ssh: heartbeatIntervalMs must be a positive integer')
    }
    if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
      throw new Error('dsh-remote-ssh: heartbeatTimeoutMs must be a positive integer')
    }
    const { reconnectInitialDelayMs, reconnectMaxDelayMs } = this.config
    if (!Number.isSafeInteger(reconnectInitialDelayMs) || reconnectInitialDelayMs <= 0) {
      throw new Error('dsh-remote-ssh: reconnectInitialDelayMs must be a positive integer')
    }
    if (!Number.isSafeInteger(reconnectMaxDelayMs) || reconnectMaxDelayMs <= 0) {
      throw new Error('dsh-remote-ssh: reconnectMaxDelayMs must be a positive integer')
    }
    if (protocolVersions.length === 0 || protocolVersions.some(version => version.trim().length === 0)) {
      throw new Error('dsh-remote-ssh: protocolVersions must contain non-empty versions')
    }
  }

  /** Open one Agent Host connection. Overridable so tests can drive the link. */
  protected async open(): Promise<AhpConnection> {
    // A reopened link must not target the remote Host instance left behind by
    // the previous tunnel, so every attempt gets its own instance id.
    this.generation += 1
    if (this.config.directUrl !== undefined) return this.connectEndpoint(this.config.directUrl)
    return this.openOverSsh()
  }

  private async connectEndpoint(url: string): Promise<AhpConnection> {
    const transport = await WebSocketTransport.connect(url)
    const client = new AhpClient(transport, { requestTimeoutMs: this.config.requestTimeoutMs })
    client.connect()
    try {
      const initialized = await client.initialize({
        clientId: this.clientId,
        protocolVersions: this.config.protocolVersions,
        initialSubscriptions: ['ahp-root://'],
      })
      const remoteUri = fileUriFromPosixPath(this.remoteAccessRoot)
      await client.resourceRequest({ uri: remoteUri, read: true, write: true })
      const runtimeUri = fileUriFromPosixPath(this.runtimeRoot)
      await client.resourceRequest({ uri: fileUriFromPosixPath(this.config.remoteRuntimeRoot), read: true, write: true })
      await client.resourceMkdir({ uri: runtimeUri })
      return {
        client,
        protocolVersion: initialized.protocolVersion,
        ...(initialized.defaultDirectory !== undefined ? { defaultDirectory: initialized.defaultDirectory } : {}),
      }
    } catch (error: unknown) {
      await client.shutdown().catch(() => {})
      throw error
    }
  }

  private async openOverSsh(): Promise<AhpConnection> {
    const diagnostics: string[] = []
    const startupCommand = buildRemoteAgentHostCommand(this.config.remoteCodeCommand)
    let startup: CapturedProcess
    try {
      startup = await runCaptured(
        this.config.sshExecutable,
        buildSshCommandArgs(this.config.sshArgs, this.config.sshTarget, startupCommand),
        this.config.startupTimeoutMs,
      )
    } catch (error: unknown) {
      if (this.config.remoteCodeCommand !== 'code') throw error
      diagnostics.push(`standalone CLI: ${errorMessage(error)}`)
      startup = { exitCode: null, stdout: '', stderr: '' }
    }
    const clean = stripAnsi(`${startup.stdout}\n${startup.stderr}`)
    const endpoint = /ws:\/\/(?:localhost|127\.0\.0\.1):(\d+)\?tkn=([^\s]+)/.exec(clean)
    if (endpoint?.[1] !== undefined && endpoint[2] !== undefined) {
      try {
        const url = await this.openTunnel(Number(endpoint[1]), endpoint[2])
        return await this.connectEndpoint(url)
      } catch (error: unknown) {
        this.resetSshAttempt()
        diagnostics.push(`standalone CLI: ${connectionDiagnostic(error, this.config.protocolVersions)}`)
        if (this.config.remoteCodeCommand !== 'code') {
          throw new Error(`dsh-remote-ssh: configured VS Code Agent Host failed\n${diagnostics.at(-1)}`, { cause: error })
        }
      }
    } else if (clean.trim().length > 0) {
      diagnostics.push(`standalone CLI (ssh exit ${startup.exitCode ?? 'unknown'}): ${tailDiagnostic(clean)}`)
    }

    // A Remote - SSH server installation exposes bin/remote-cli/code, but that
    // wrapper deliberately refuses ordinary SSH sessions. Its sibling
    // bin/code-server can host the same official Agent Host directly. Probe
    // every installed build newest-first: a newer VS Code may speak a protocol
    // that the bundled AHP client has not adopted yet, while an older compatible
    // build remains usable.
    if (this.config.remoteCodeCommand !== 'code') {
      throw new Error(`dsh-remote-ssh: remote VS Code Agent Host failed to start (ssh exit ${startup.exitCode})\n${clean}`)
    }
    const candidates = await this.listEmbeddedAgentHosts()
    for (const [index, codeServerPath] of candidates.entries()) {
      try {
        const url = await this.startEmbeddedAgentHost(codeServerPath, index)
        return await this.connectEndpoint(url)
      } catch (error: unknown) {
        this.resetSshAttempt()
        diagnostics.push(`embedded ${codeServerPath}: ${connectionDiagnostic(error, this.config.protocolVersions)}`)
      }
    }
    if (candidates.length === 0) diagnostics.push('embedded VS Code Server: no installed code-server found')
    throw new Error(`dsh-remote-ssh: no compatible VS Code Agent Host found\n${diagnostics.join('\n')}`)
  }

  private async listEmbeddedAgentHosts(): Promise<string[]> {
    const result = await runCaptured(
      this.config.sshExecutable,
      buildSshCommandArgs(this.config.sshArgs, this.config.sshTarget, buildListEmbeddedAgentHostsCommand()),
      Math.min(this.config.startupTimeoutMs, 30_000),
    )
    if (result.exitCode !== 0) return []
    return [...new Set(result.stdout.split(/\r?\n/u).map(path => path.trim()).filter(Boolean))]
  }

  private async startEmbeddedAgentHost(codeServerPath: string, attempt: number): Promise<string> {
    const instanceId = `${this.clientId}-${this.generation}-${attempt}`
    const child = spawn(this.config.sshExecutable, buildSshCommandArgs(
      this.config.sshArgs,
      this.config.sshTarget,
      buildEmbeddedAgentHostCommand(codeServerPath, instanceId),
    ), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.embeddedAgentHost = child
    // The remote Host is started through one SSH session: when that session
    // ends, the Agent Host behind it is unreachable and the link is dead.
    child.once('close', () => {
      if (this.embeddedAgentHost !== child) return
      this.embeddedAgentHost = undefined
      this.markStale()
    })
    let remotePort: number
    try {
      remotePort = await waitForAgentHostPort(child, this.config.startupTimeoutMs)
    } catch (error: unknown) {
      child.kill()
      throw error
    }
    const tokenResult = await runCaptured(
      this.config.sshExecutable,
      buildSshCommandArgs(
        this.config.sshArgs,
        this.config.sshTarget,
        `cat "$HOME/.dsh-remote-ssh/server-embedded/${instanceId}/data/token"`,
      ),
      Math.min(this.config.startupTimeoutMs, 30_000),
    )
    const token = tokenResult.stdout.trim()
    if (tokenResult.exitCode !== 0 || token.length === 0 || /\s/.test(token)) {
      child.kill()
      throw new Error(`dsh-remote-ssh: could not read the embedded Agent Host connection token\n${tokenResult.stderr}`)
    }
    return this.openTunnel(remotePort, token)
  }

  private async openTunnel(remotePort: number, token: string): Promise<string> {
    const localPort = await reservePort()
    const tunnel = spawn(this.config.sshExecutable, [
      ...this.config.sshArgs,
      '-T',
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      ...SSH_KEEPALIVE_ARGS,
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      this.config.sshTarget,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.tunnel = tunnel
    // A dropped forward means the websocket behind it is gone; record the link
    // as dead so the next call reopens instead of reusing a closed client.
    tunnel.once('close', () => {
      if (this.tunnel !== tunnel) return
      this.tunnel = undefined
      this.markStale()
    })
    await waitForPort(localPort, tunnel, 15_000)
    return `ws://127.0.0.1:${localPort}?tkn=${encodeURIComponent(token)}`
  }

  private resetSshAttempt(): void {
    this.tunnel?.kill()
    this.tunnel = undefined
    this.embeddedAgentHost?.kill()
    this.embeddedAgentHost = undefined
  }
}

interface CapturedProcess {
  exitCode: number | null
  stdout: string
  stderr: string
}

async function runCaptured(command: string, args: string[], timeoutMs: number): Promise<CapturedProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    const append = (bucket: Buffer[], chunk: Buffer): void => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        child.kill()
        reject(new Error('dsh-remote-ssh: SSH startup output exceeded 4 MiB'))
        return
      }
      bucket.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => { append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { append(stderr, chunk) })
    child.once('error', reject)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`dsh-remote-ssh: SSH startup timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function waitForAgentHostPort(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      operation()
    }
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output, 'utf8') > 4 * 1024 * 1024) {
        finish(() => reject(new Error('embedded Agent Host startup output exceeded 4 MiB')))
        return
      }
      const match = /Agent host server listening on (?:localhost|127\.0\.0\.1):(\d+)/.exec(stripAnsi(output))
      if (match?.[1] !== undefined) finish(() => resolvePromise(Number(match[1])))
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', error => { finish(() => reject(error)) })
    child.once('close', code => {
      finish(() => reject(new Error(`embedded Agent Host SSH process exited with code ${code}\n${stripAnsi(output)}`)))
    })
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`embedded Agent Host startup timed out after ${timeoutMs}ms\n${stripAnsi(output)}`)))
    }, timeoutMs)
  })
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reject with `label` unless `promise` settles within `timeoutMs`. */
function withDeadline(promise: Promise<unknown>, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer: NodeJS.Timeout = setTimeout(() => { reject(new Error(label)) }, timeoutMs)
    timer.unref?.()
    promise.then(
      () => { clearTimeout(timer); resolve() },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** ±20% jitter so concurrent runtimes do not retry in lockstep. */
function jitter(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds * (0.8 + Math.random() * 0.4)))
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal)
  return new Promise((resolve, reject) => {
    const timer: NodeJS.Timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted')
}

function tailDiagnostic(value: string, maxLength = 2_000): string {
  const clean = stripAnsi(value).trim()
  return clean.length <= maxLength ? clean : `…${clean.slice(-maxLength)}`
}

function connectionDiagnostic(error: unknown, offeredVersions: readonly string[]): string {
  const mismatch = ahpProtocolMismatch(error, offeredVersions)
  return mismatch === undefined ? tailDiagnostic(errorMessage(error)) : `AHP protocol mismatch: ${formatAhpProtocolMismatch(mismatch)}`
}

async function reservePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('dsh-remote-ssh: failed to reserve a TCP port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePromise(port) : reject(error))
    })
  })
}

async function waitForPort(port: number, child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh-remote-ssh: SSH tunnel exited with code ${child.exitCode}`)
    const connected = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
      socket.once('error', () => { socket.destroy(); resolvePromise(false) })
    })
    if (connected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  child.kill()
  throw new Error(`dsh-remote-ssh: SSH tunnel did not open port ${port} within ${timeoutMs}ms`)
}

export default RemoteSshRuntime
