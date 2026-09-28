import { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type { RemoteSshManager } from './manager.ts'

export interface Config {
  dialect: 'bash' | 'pwsh'
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
  executable?: string
}

interface ResolvedConfig extends Config {
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  maxSpillBytes: number
  graceMs: number
}

const PWSH_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Syntax-specific shell provider over the cwd-routed subprocess service. */
export class TransparentShellExecutor extends ShellExecutor {
  static inject = ['subprocess', 'remoteSshManager']
  static Config: z<Config> = z.object({
    dialect: z.union(['bash', 'pwsh'] as const).required(),
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(64 * 1024 * 1024),
    graceMs: z.number().default(3_000),
    executable: z.string(),
  })

  private readonly config: ResolvedConfig
  private readonly manager: RemoteSshManager

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    this.manager = ctx.remoteSshManager
    for (const name of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'] as const) {
      const value = this.config[name]
      if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-remote-ssh/shell-transparent: ${name} must be positive`)
    }
  }

  /** Remote and local routing is explicitly unconfined at the process layer. */
  override get sandboxMode(): 'danger-full-access' {
    return 'danger-full-access'
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(Math.floor(request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs)
    const stdoutMaxBytes = Math.floor(request.stdoutMaxBytes ?? this.config.maxOutputBytes)
    if (timeoutMs <= 0 || stdoutMaxBytes <= 0) throw new Error('dsh-remote-ssh/shell-transparent: timeout and output limits must be positive')
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
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

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    assertUnconfined(spec)
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'remote') {
      const execution = await (await this.manager.workspaceShell(route, this.config.dialect)).execute(spec)
      execution.sandbox = { mode: 'danger-full-access', denied: false }
      return execution
    }
    return new LocalShellExecution(
      spec,
      signal => this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, signal)),
    )
  }

  private spawnSpec(spec: ShellExecSpec, stdoutMaxBytes: number, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: this.argv(spec.command),
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', ...spec.env, ...spec.dshEnv },
    }
  }

  private argv(command: string): string[] {
    if (this.config.dialect === 'bash') return [this.config.executable ?? 'bash', '-c', command]
    return [this.config.executable ?? 'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PWSH_PREAMBLE + command]
  }
}

/**
 * Local execution handle: the subprocess's collected readers feed both the
 * consuming read cursor and the non-consuming `observed` view. The spec's
 * deadline policy (`onExpiry`) drives one fused timeout/abort cause for the
 * foreground projection, exactly like the previous split run() path.
 */
class LocalShellExecution implements ShellExecution {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  sandbox = { mode: 'danger-full-access' as const, denied: false }
  readonly done: Promise<void>
  readonly observed: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }

  private readonly handle: SubprocessHandle
  private readonly spec: ShellExecSpec
  private readonly collected: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }
  private readonly settled: Promise<{ outcome: SubprocessOutcome; cause: 'timeout' | 'abort' | undefined }>
  private readonly timer: ReturnType<typeof setTimeout> | undefined
  private readonly abortListener: (() => void) | undefined
  private stdoutOffset = 0
  private stderrOffset = 0
  private spawnFailure: string | undefined
  private resultPromise: Promise<ShellRunResult> | undefined

  constructor(spec: ShellExecSpec, spawn: (signal: AbortSignal | undefined) => SubprocessHandle) {
    this.spec = spec
    const controller = new AbortController()
    let cause: 'timeout' | 'abort' | undefined
    const abort = (): void => {
      if (cause !== undefined) return
      cause = 'abort'
      controller.abort(spec.signal?.reason)
    }
    if (spec.signal?.aborted) abort()
    else if (spec.signal !== undefined) {
      this.abortListener = abort
      spec.signal.addEventListener('abort', abort, { once: true })
    }
    if (spec.onExpiry !== 'none') {
      this.timer = setTimeout(() => {
        if (cause !== undefined) return
        cause = 'timeout'
        controller.abort(new Error('shell timeout'))
      }, spec.timeoutMs)
    }
    this.handle = spec.signal === undefined && this.timer === undefined
      ? spawn(undefined)
      : spawn(controller.signal)
    this.collected = requireCollected(this.handle)
    this.observed = { stdout: this.collected.stdout, stderr: this.collected.stderr }
    this.settled = this.handle.done.then(outcome => ({ outcome, cause }), (error: unknown) => {
      this.spawnFailure = `spawn failed: ${String(error)}`
      throw error
    })
    this.done = this.settled.then(({ outcome }) => {
      this.exitCode = outcome.exitCode
      this.signal = outcome.signal
      this.status = outcome.signal === null ? 'completed' : 'killed'
    }, () => {
      this.status = 'killed'
      this.signal = 'SIGTERM'
    })
  }

  readOutput(): ShellProcessRead {
    const stdout = this.collected.stdout.readFrom(this.stdoutOffset)
    const stderr = this.collected.stderr.readFrom(this.stderrOffset)
    this.stdoutOffset = stdout.nextOffset
    this.stderrOffset = stderr.nextOffset
    const error = stderr.text || this.spawnFailure || ''
    this.spawnFailure = undefined
    return {
      delta: stdout.text + (error.length === 0 ? '' : `${stdout.text.length > 0 && !stdout.text.endsWith('\n') ? '\n' : ''}[stderr]\n${error}`),
      lossy: stdout.lossy || stderr.lossy,
      ...(stdout.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
      ...(stderr.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }),
    }
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.status = 'killed'
    this.handle.terminate()
    return true
  }

  result(): Promise<ShellRunResult> {
    this.resultPromise ??= this.settled.then(({ outcome, cause }) => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.abortListener !== undefined) this.spec.signal?.removeEventListener('abort', this.abortListener)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: cause === 'timeout',
        aborted: cause === 'abort',
        timeoutMs: this.spec.timeoutMs,
        stdout: finalOutput(this.collected.stdout),
        stderr: finalOutput(this.collected.stderr),
        sandbox: { mode: 'danger-full-access', denied: false },
      }
    })
    return this.resultPromise
  }
}

function assertUnconfined(spec: ShellExecSpec): void {
  if (spec.sandboxPolicy !== undefined && spec.sandboxPolicy.mode !== 'danger-full-access') {
    throw new Error(`dsh-remote-ssh: transparent shell cannot enforce ${spec.sandboxPolicy.mode} across SSH; select danger-full-access or confine the SSH account`)
  }
}

function requireCollected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
  const { stdout, stderr } = handle.collected
  if (stdout === undefined || stderr === undefined) throw new Error('dsh-remote-ssh: subprocess dropped requested collected output')
  return { stdout, stderr }
}

function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const value = reader.readFrom(0)
  return {
    text: value.text,
    truncated: value.lossy,
    ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath }),
  }
}

export default TransparentShellExecutor
