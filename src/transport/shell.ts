import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { ContentEncoding, TerminalClientClaim } from '@microsoft/agent-host-protocol'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type { RemoteSshRuntime } from './runtime.ts'
import { fileUriFromPosixPath, quotePosix, WorkspacePathMapper } from './runtime.ts'
import { normalizeRemotePath, toNativeRemotePath, type RemoteOs } from './remote-paths.ts'
import {
  buildPowerShellProcessScript,
  POWERSHELL_UTF8_PREAMBLE,
  powerShellCommand,
  psMarkerBegin,
  psMarkerEnd,
  quotePowerShell,
} from './powershell.ts'

export interface Config {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  outputMaxBytes?: number
  maxOutputMaxBytes?: number
  shellCommand?: string
  localWorkspace?: string
  remoteWorkspace?: string
}

interface ResolvedConfig extends Config {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  outputMaxBytes: number
  maxOutputMaxBytes: number
  shellCommand: string
}

interface ExecutionOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  output: TailBuffer
}

const UTF8 = 'utf-8' as ContentEncoding

export class RemoteSshShellExecutor extends ShellExecutor {
  static inject = ['remoteSsh']
  static Config: z<Config> = z.object({
    defaultTimeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    outputMaxBytes: z.number().default(256 * 1024),
    maxOutputMaxBytes: z.number().default(16 * 1024 * 1024),
    shellCommand: z.string().default('bash'),
    localWorkspace: z.string(),
    remoteWorkspace: z.string(),
  })

  readonly config: ResolvedConfig
  private readonly remote: RemoteSshRuntime
  private readonly mapper: WorkspacePathMapper
  private readonly processes = new Set<AhpShellExecution>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.remote = ctx.remoteSsh
    this.config = config as ResolvedConfig
    if ((config.localWorkspace === undefined) !== (config.remoteWorkspace === undefined)) {
      throw new Error('dsh-remote-ssh/shell: localWorkspace and remoteWorkspace must be configured together')
    }
    this.mapper = config.localWorkspace !== undefined && config.remoteWorkspace !== undefined
      ? new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace, this.remoteOs)
      : mapperOf(this.remote)
    this.validate()
    ctx.effect(() => async () => {
      for (const process of this.processes) process.kill()
      await Promise.allSettled([...this.processes].map(process => process.done))
    }, 'Remote SSH shell teardown')
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampPositive(request.timeoutMs ?? this.config.defaultTimeoutMs, this.config.maxTimeoutMs, 'timeoutMs')
    const stdoutMaxBytes = clampPositive(request.stdoutMaxBytes ?? this.config.outputMaxBytes, this.config.maxOutputMaxBytes, 'stdoutMaxBytes')
    return {
      command: request.command,
      workdir: request.workdir ?? this.mapper.localWorkspace,
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const process = new AhpShellExecution(
      this.remote,
      this.mapper,
      this.config.shellCommand,
      spec,
    )
    this.processes.add(process)
    void process.done.finally(() => { this.processes.delete(process) })
    return Promise.resolve(process)
  }

  /** OS dialect of the remote host; test doubles default to POSIX. */
  private get remoteOs(): RemoteOs {
    return this.remote.remoteOs ?? 'posix'
  }

  private validate(): void {
    for (const name of ['defaultTimeoutMs', 'maxTimeoutMs', 'outputMaxBytes', 'maxOutputMaxBytes'] as const) {
      const value = this.config[name]
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-remote-ssh/shell: ${name} must be a positive integer`)
    }
    if (this.config.defaultTimeoutMs > this.config.maxTimeoutMs) throw new Error('dsh-remote-ssh/shell: defaultTimeoutMs exceeds maxTimeoutMs')
    if (this.config.outputMaxBytes > this.config.maxOutputMaxBytes) throw new Error('dsh-remote-ssh/shell: outputMaxBytes exceeds maxOutputMaxBytes')
    if (this.config.shellCommand.trim().length === 0) throw new Error('dsh-remote-ssh/shell: shellCommand must be non-empty')
  }
}

class AhpShellExecution implements ShellExecution {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>
  readonly observed: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }

  private readonly controller = new AbortController()
  private readonly output: TailBuffer
  private readonly outcome: Promise<ExecutionOutcome & { spec: ShellExecSpec }>
  private resultPromise: Promise<ShellRunResult> | undefined

  constructor(remote: RemoteSshRuntime, mapper: WorkspacePathMapper, shellCommand: string, spec: ShellExecSpec) {
    this.output = new TailBuffer(spec.stdoutMaxBytes)
    this.observed = {
      stdout: offsetReader(from => this.output.readFrom(from)),
      stderr: offsetReader(() => ({ text: '', nextOffset: 0, lossy: false })),
    }
    const deadlineMs = spec.onExpiry === 'none' ? 0 : spec.timeoutMs
    this.outcome = executeTerminal(
      remote,
      mapper,
      shellCommand,
      { ...spec, signal: combineSignals(spec.signal, this.controller.signal) },
      spec.stdoutMaxBytes,
      deadlineMs,
      this.output,
    ).then(outcome => ({ ...outcome, spec }), (error: unknown) => {
      this.output.append(`\n[dsh-remote-ssh infrastructure error] ${errorMessage(error)}\n`)
      throw error
    })
    this.done = this.outcome.then((outcome) => {
      this.exitCode = outcome.exitCode
      this.signal = outcome.signal
      this.status = outcome.signal === null ? 'completed' : 'killed'
    }, () => {
      this.exitCode = null
      this.signal = 'SIGTERM'
      this.status = 'killed'
    })
  }

  readOutput(): ShellProcessRead {
    return this.output.readIncremental()
  }

  kill(): boolean {
    if (this.status !== 'running' || this.controller.signal.aborted) return false
    this.controller.abort(new Error('background process killed'))
    return true
  }

  result(): Promise<ShellRunResult> {
    this.resultPromise ??= this.outcome.then(outcome => ({
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      timeoutMs: outcome.spec.timeoutMs,
      stdout: outcome.output.collected(),
      stderr: { text: '', truncated: false },
    }))
    return this.resultPromise
  }
}

/** Adapt a stateless byte-offset read into the seam's non-consuming reader. */
function offsetReader(readFrom: (fromByte: number) => SubprocessOutputRead): SubprocessOutputReader {
  return { readFrom }
}

async function executeTerminal(
  remote: RemoteSshRuntime,
  mapper: WorkspacePathMapper,
  shellCommand: string,
  spec: ShellExecSpec,
  outputMaxBytes: number,
  timeoutMs: number,
  existingOutput?: TailBuffer,
): Promise<ExecutionOutcome> {
  const output = existingOutput ?? new TailBuffer(outputMaxBytes)
  if (spec.sandboxPolicy !== undefined && spec.sandboxPolicy.mode !== 'danger-full-access') {
    throw new Error(`dsh-remote-ssh/shell: ${spec.sandboxPolicy.mode} cannot confine arbitrary remote commands; use danger-full-access or a separately sandboxed SSH account`)
  }
  const client = await remote.getClient()
  const token = randomUUID()
  const terminalUri = `ahp-terminal:/${token}`
  const os: RemoteOs = remote.remoteOs ?? 'posix'
  const commandPath = posix.join(remote.runtimeRoot, `command-${token}.${os === 'windows' ? 'ps1' : 'sh'}`)
  const stdinPath = posix.join(remote.runtimeRoot, `stdin-${token}.bin`)
  const commandUri = fileUriFromPosixPath(commandPath)
  const stdinUri = fileUriFromPosixPath(stdinPath)
  const workdir = mapper.toRemotePath(spec.workdir)
  let subscription: Subscription | undefined
  let terminalCreated = false
  let stdinCreated = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let stopCause: 'timeout' | 'abort' | undefined
  let resolveStop: ((cause: 'timeout' | 'abort') => void) | undefined
  const stopped = new Promise<'timeout' | 'abort'>(resolvePromise => { resolveStop = resolvePromise })

  const stop = (cause: 'timeout' | 'abort'): void => {
    if (stopCause !== undefined) return
    stopCause = cause
    resolveStop?.(cause)
  }

  try {
    if (spec.signal?.aborted) stop('abort')
    const invocation = buildTerminalInvocation(os, {
      token,
      command: spec.command,
      env: mergeEnvironment(mapper, spec),
      shellCommand,
      commandPath,
      stdinPath,
      stdinCreated: spec.stdin !== undefined,
    })
    await client.resourceWrite({ uri: commandUri, data: invocation.payload, encoding: UTF8, contentType: invocation.contentType })
    if (spec.stdin !== undefined) {
      await client.resourceWrite({ uri: stdinUri, data: Buffer.from(spec.stdin).toString('base64'), encoding: 'base64' as ContentEncoding })
      stdinCreated = true
    }
    const claim = { kind: 'client', clientId: remote.clientId } as TerminalClientClaim
    await client.request('createTerminal', {
      channel: terminalUri,
      claim,
      name: 'DeepSeek Harness Remote SSH',
      cwd: fileUriFromPosixPath(workdir),
      cols: 120,
      rows: 30,
    })
    terminalCreated = true
    const subscribed = await client.subscribe(terminalUri)
    subscription = subscribed.subscription

    if (timeoutMs > 0) timer = setTimeout(() => { stop('timeout') }, timeoutMs)
    if (spec.signal !== undefined) {
      abortListener = () => { stop('abort') }
      spec.signal.addEventListener('abort', abortListener, { once: true })
    }

    // Control-byte markers distinguish executed output from PTY prompt/input
    // echo even when the embedded Agent Host exposes no command-detection
    // actions. The echoed source contains the printable escape spelling, not
    // the RS/US bytes emitted by printf — or, on Windows, only base64.
    // ConPTY strips the control bytes themselves, so the Windows matcher
    // accepts the bare marker text (see TerminalOutputCapture).
    const marker = new TerminalOutputCapture(token, output, os)
    client.dispatch(terminalUri, { type: ActionType.TerminalInput, data: `${invocation.input}\r` })

    let commandId: string | undefined
    for (;;) {
      const eventOrStop = await Promise.race([
        subscription.next().then(result => ({ kind: 'event' as const, result })),
        stopped.then(cause => ({ kind: 'stop' as const, cause })),
      ])
      if (eventOrStop.kind === 'stop') {
        await client.request('disposeTerminal', { channel: terminalUri }).catch(() => {})
        terminalCreated = false
        return {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: eventOrStop.cause === 'timeout',
          aborted: eventOrStop.cause === 'abort',
          output,
        }
      }
      if (eventOrStop.result.done) {
        throw new Error('Agent Host terminal subscription ended before command completion')
      }
      const event = eventOrStop.result.value
      if (event.type !== 'action') continue
      const action = event.params.action
      if (action.type === ActionType.TerminalCommandExecuted && commandId === undefined) {
        commandId = action.commandId
      } else if (action.type === ActionType.TerminalData) {
        const exitCode = marker.push(action.data)
        if (exitCode !== undefined) {
          return {
            exitCode,
            signal: null,
            timedOut: false,
            aborted: false,
            output,
          }
        }
      } else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId && marker.started) {
        // The marker is authoritative. Keep reading because commandFinished
        // may race the final terminal/data action on different Agent Hosts.
        continue
      } else if (action.type === ActionType.TerminalCommandFinished && commandId === undefined) {
        continue
      } else if (action.type === ActionType.TerminalCommandFinished && action.commandId === commandId) {
        return {
          exitCode: action.exitCode ?? null,
          signal: null,
          timedOut: false,
          aborted: false,
          output,
        }
      } else if (action.type === ActionType.TerminalExited) {
        if (!marker.finished) {
          throw new Error(`Agent Host terminal exited before the output marker (exit ${action.exitCode ?? 'unknown'})`)
        }
        return {
          exitCode: action.exitCode ?? null,
          signal: action.exitCode === undefined ? 'SIGTERM' : null,
          timedOut: false,
          aborted: false,
          output,
        }
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortListener !== undefined) spec.signal?.removeEventListener('abort', abortListener)
    await subscription?.close().catch(() => {})
    if (terminalCreated) await client.request('disposeTerminal', { channel: terminalUri }).catch(() => {})
    await client.resourceDelete({ uri: commandUri }).catch(() => {})
    if (stdinCreated) await client.resourceDelete({ uri: stdinUri }).catch(() => {})
  }
}

export interface TerminalInvocation {
  /** Staged payload content written to the command Resource. */
  payload: string
  /** Content type declared for the staged payload. */
  contentType: string
  /** Line typed into the AHP terminal to run the staged payload. */
  input: string
}

/**
 * Build the staged payload and the PTY input line for one shell call.
 *
 * POSIX keeps the historic one-liner (`printf` markers, `env` prefix, `<`
 * redirection). Windows stages a `.ps1` payload and types a
 * `powershell -EncodedCommand` wrapper — the wrapper survives any DefaultShell
 * (cmd or PowerShell) unescaped, applies the environment, copies the staged
 * stdin file into the child, and re-emits the exact same RS/US marker bytes
 * via `[Console]::Write` so the local parser is unchanged.
 */
export function buildTerminalInvocation(os: RemoteOs, params: {
  token: string
  command: string
  env: Record<string, string>
  shellCommand: string
  commandPath: string
  stdinPath: string
  stdinCreated: boolean
}): TerminalInvocation {
  if (os === 'posix') {
    const envArgs = Object.entries(params.env).map(([key, value]) => `${key}=${quotePosix(value)}`).join(' ')
    const stdinRedirect = params.stdinCreated ? quotePosix(params.stdinPath) : '/dev/null'
    return {
      payload: params.command,
      contentType: 'text/x-shellscript',
      input: `printf '\\036DSH:${params.token}:BEGIN\\037'; env ${envArgs} ${quotePosix(params.shellCommand)} ${quotePosix(params.commandPath)} < ${stdinRedirect}; __dsh_status=$?; printf '\\036DSH:${params.token}:END:%s\\037' "$__dsh_status"; exit "$__dsh_status"`,
    }
  }
  const lines: string[] = []
  for (const [key, value] of Object.entries(params.env)) {
    const native = key === 'DSH_CWD' ? toNativeRemotePath(os, normalizeRemotePath(os, value)) : value
    lines.push(`$env:${key} = ${quotePowerShell(native)}`)
  }
  lines.push(
    psMarkerBegin(params.token),
    `$dsh_shell = ${quotePowerShell(params.shellCommand)}`,
    `if ($dsh_shell -eq 'pwsh' -and -not (Get-Command pwsh -ErrorAction SilentlyContinue)) { $dsh_shell = 'powershell' }`,
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    '$psi.FileName = $dsh_shell',
    `$psi.Arguments = ${quotePowerShell(`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${toNativeRemotePath(os, params.commandPath)}"`)}`,
    '$psi.UseShellExecute = $false',
    '$psi.RedirectStandardInput = $true',
    '$p = [System.Diagnostics.Process]::Start($psi)',
  )
  if (params.stdinCreated) {
    lines.push(
      `$stdinFile = [System.IO.File]::OpenRead(${quotePowerShell(toNativeRemotePath(os, params.stdinPath))})`,
      // The payload may exit without reading stdin; a broken pipe then ends
      // the copy instead of failing the wrapper.
      'try { $stdinFile.CopyTo($p.StandardInput.BaseStream) } catch { }',
      '$stdinFile.Close()',
    )
  }
  lines.push(
    'try { $p.StandardInput.Close() } catch { }',
    '$p.WaitForExit()',
    '$dsh_status = $p.ExitCode',
    psMarkerEnd(params.token, '$dsh_status'),
    'exit $dsh_status',
  )
  return {
    payload: `${POWERSHELL_UTF8_PREAMBLE}\n${params.command}`,
    contentType: 'text/x-powershell',
    input: powerShellCommand(lines.join('\n')),
  }
}

/**
 * Completion tracker for one staged terminal command.
 *
 * POSIX remotes echo the typed invocation verbatim, so markers are matched
 * with their RS/US framing intact (`\x1eDSH:<token>:BEGIN\x1f`): the echoed
 * source spells the escapes printable (`\036…\037`) and never carries the
 * control bytes themselves.
 *
 * Windows ConPTY re-serializes the screen buffer instead of forwarding
 * bytes, and RS/US are non-rendering controls — they vanish from the
 * stream, leaving bare `DSH:<token>:BEGIN` / `DSH:<token>:END:<status>`
 * text. Bare matching stays collision-free there because the typed
 * invocation is `powershell -EncodedCommand <base64>` (token only inside
 * the base64), so the echo cannot contain the plaintext token. Both
 * spellings treat the framing controls as optional on Windows, in case a
 * terminal pipeline ever passes them through; the exit status there ends
 * at the first non-digit instead of requiring the US terminator.
 */
class TerminalOutputCapture {
  /** Longest BEGIN spelling, bounding the partial-marker prefix retained between pushes. */
  private readonly beginBound: number
  private readonly endBound: number
  private readonly beginMatcher: RegExp
  private readonly endMatcher: RegExp
  private readonly windows: boolean
  started = false
  finished = false
  private pending = ''

  constructor(token: string, private readonly output: TailBuffer, os: RemoteOs = 'posix') {
    const literal = `DSH:${token}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    this.windows = os === 'windows'
    const frame = this.windows ? ['\\x1e?', '(?:\\x1f)?'] as const : ['\\x1e', '\\x1f'] as const
    this.beginMatcher = new RegExp(`${frame[0]}${literal}:BEGIN${frame[1]}`)
    this.endMatcher = new RegExp(`${frame[0]}${literal}:END:`)
    this.beginBound = `\x1eDSH:${token}:BEGIN\x1f`.length - 1
    this.endBound = `\x1eDSH:${token}:END:`.length - 1
  }

  push(data: string): number | undefined {
    if (this.finished) return undefined
    this.pending += data
    if (!this.started) {
      const begin = this.beginMatcher.exec(this.pending)
      if (begin === null) {
        this.pending = this.pending.slice(-Math.max(0, this.beginBound))
        return undefined
      }
      this.started = true
      this.pending = this.pending.slice(begin.index + begin[0].length)
    }

    const end = this.endMatcher.exec(this.pending)
    if (end === null) {
      const safe = Math.max(0, this.pending.length - this.endBound)
      if (safe > 0) {
        this.output.append(this.pending.slice(0, safe))
        this.pending = this.pending.slice(safe)
      }
      return undefined
    }
    this.output.append(this.pending.slice(0, end.index))
    const status = this.statusAfter(end.index + end[0].length)
    if (status === undefined) {
      // Retain the marker and its partial status until the next data action.
      this.pending = this.pending.slice(end.index)
      return undefined
    }
    if ('invalid' in status) throw new Error(`Agent Host terminal emitted an invalid exit marker: ${JSON.stringify(status.invalid)}`)
    this.finished = true
    this.pending = ''
    return status.exitCode
  }

  /** Read the exit status after an END marker; `undefined` while it is still partial. */
  private statusAfter(statusStart: number): { exitCode: number } | { invalid: string } | undefined {
    if (this.windows) {
      let index = statusStart
      while (index < this.pending.length && this.pending[index]! >= '0' && this.pending[index]! <= '9') index += 1
      if (index >= this.pending.length) return undefined
      const raw = this.pending.slice(statusStart, index)
      if (raw.length > 0) return { exitCode: Number(raw) }
      return { invalid: raw + this.pending[index] }
    }
    const terminator = this.pending.indexOf('\x1f', statusStart)
    if (terminator === -1) return undefined
    const raw = this.pending.slice(statusStart, terminator)
    // A Windows wrapper may echo a carriage return before the US terminator.
    if (!/^\d+\r?$/.test(raw)) return { invalid: raw }
    return { exitCode: Number(raw.replace(/\r$/, '')) }
  }
}

function mergeEnvironment(mapper: WorkspacePathMapper, spec: ShellExecSpec): Record<string, string> {
  const result: Record<string, string> = { ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) }
  if (result.DSH_CWD !== undefined) result.DSH_CWD = mapper.toRemotePath(result.DSH_CWD)
  for (const key of Object.keys(result)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid remote environment variable name: ${key}`)
    if (result[key]?.includes('\0')) throw new Error(`remote environment variable ${key} contains a NUL byte`)
  }
  return result
}

class TailBuffer {
  private tail = Buffer.alloc(0)
  private tailStart = 0
  private total = 0
  private readOffset = 0

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    const chunk = Buffer.from(value)
    this.total += chunk.length
    const combined = Buffer.concat([this.tail, chunk])
    if (combined.length > this.maxBytes) {
      const dropped = combined.length - this.maxBytes
      this.tail = combined.subarray(dropped)
      this.tailStart += dropped
    } else {
      this.tail = combined
    }
  }

  collected(): CollectedOutput {
    return { text: this.tail.toString('utf8'), truncated: this.tailStart > 0 }
  }

  readIncremental(): ShellProcessRead {
    const lossy = this.readOffset < this.tailStart
    const start = Math.max(this.readOffset, this.tailStart) - this.tailStart
    const delta = this.tail.subarray(start).toString('utf8')
    this.readOffset = this.total
    return { delta, lossy }
  }

  /** Non-consuming byte-offset read over the same captured tail. */
  readFrom(fromByte: number): SubprocessOutputRead {
    const lossy = fromByte < this.tailStart
    const start = Math.max(fromByte, this.tailStart) - this.tailStart
    return {
      text: this.tail.subarray(start).toString('utf8'),
      nextOffset: this.total,
      lossy,
    }
  }
}

function clampPositive(value: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-remote-ssh/shell: ${name} must be positive`)
  return Math.min(Math.floor(value), max)
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapperOf(remote: RemoteSshRuntime): ReturnType<RemoteSshRuntime['getMapper']> {
  return remote.mapper ?? remote.getMapper()
}

export default RemoteSshShellExecutor
