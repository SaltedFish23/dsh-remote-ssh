import { resolve } from 'node:path'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteSshRuntime } from '../src/transport/runtime.ts'
import { WorkspacePathMapper } from '../src/transport/runtime.ts'
import RemoteSshShellExecutor from '../src/transport/shell.ts'
import { describe, expect, it } from 'vitest'

class FakeSubscription implements AsyncIterableIterator<SubscriptionEvent> {
  private readonly events: SubscriptionEvent[] = []
  push(action: object): void {
    this.events.push({ type: 'action', params: { channel: 'ahp-terminal:/test', serverSeq: this.events.length + 1, action } } as SubscriptionEvent)
  }
  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    while (this.events.length === 0) await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    return { value: this.events.shift()!, done: false }
  }
  async return(): Promise<IteratorResult<SubscriptionEvent>> { return { value: undefined, done: true } }
  [Symbol.asyncIterator](): this { return this }
  async close(): Promise<void> {}
}

class FakeTerminalAhp {
  readonly subscription = new FakeSubscription()
  readonly writes: string[] = []
  disposed = false

  async resourceWrite({ uri }: { uri: string }) { this.writes.push(uri); return {} }
  async resourceDelete() { return {} }
  async request(method: string) {
    if (method === 'disposeTerminal') this.disposed = true
    return {}
  }
  async subscribe() {
    return { result: { snapshot: { resource: 'ahp-terminal:/test', state: {} } }, subscription: this.subscription as unknown as Subscription }
  }
  dispatch(_channel: string, action: { data: string }) {
    const token = /DSH:([0-9a-f-]+):BEGIN/.exec(action.data)?.[1]
    if (token === undefined) throw new Error('missing output marker')
    this.subscription.push({ type: ActionType.TerminalData, data: `echoed input\r\n\x1eDSH:${token}:BE` })
    this.subscription.push({ type: ActionType.TerminalData, data: `GIN\x1fremote-output\r\n\x1eDSH:${token}:END:` })
    this.subscription.push({ type: ActionType.TerminalData, data: '7\x1ftrailing prompt' })
    this.subscription.push({ type: ActionType.TerminalExited, exitCode: 7 })
    return { clientSeq: 1 }
  }
}

async function setup() {
  const ctx = new Context()
  const client = new FakeTerminalAhp()
  const local = resolve('tests', 'shell-alias')
  const runtime = {
    mapper: new WorkspacePathMapper(local, '/srv/project'),
    runtimeRoot: '/tmp/dsh/test',
    clientId: 'test-client',
    getClient: async () => client as unknown as AhpClient,
  } as unknown as RemoteSshRuntime
  ctx.provide('remoteSsh', runtime)
  await ctx.plugin(RemoteSshShellExecutor, {
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 2000,
    outputMaxBytes: 1024,
    maxOutputMaxBytes: 4096,
    shellCommand: 'bash',
  })
  return { ctx, client, local }
}

/**
 * Replays the exact ConPTY stream shape captured from a production Windows
 * agent host (2026-10-06, terminal bb93787a): conhost init, PSReadLine
 * echoing the typed `powershell -EncodedCommand` line as base64, bare
 * markers with the RS/US controls stripped, the terminating CR arriving in
 * a separate data action, and the trailing prompt. The long base64 echo
 * chunks are trimmed to representative prefixes; what matters is that the
 * echo text is base64 and cannot contain the plaintext token.
 */
class FakeWindowsConPtyTerminal {
  readonly subscription = new FakeSubscription()
  readonly writes: string[] = []
  disposed = false

  async resourceWrite({ uri }: { uri: string }) { this.writes.push(uri); return {} }
  async resourceDelete() { return {} }
  async request(method: string) {
    if (method === 'disposeTerminal') this.disposed = true
    return {}
  }
  async subscribe() {
    return { result: { snapshot: { resource: 'ahp-terminal:/test', state: {} } }, subscription: this.subscription as unknown as Subscription }
  }
  dispatch(_channel: string, action: { data: string }) {
    const encoded = /EncodedCommand ([A-Za-z0-9=+/]+)/.exec(action.data)?.[1]
    if (encoded === undefined) throw new Error('missing EncodedCommand wrapper')
    // The plaintext token only ever exists inside the base64 payload.
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    const token = /DSH:([0-9a-f-]{36}):BEGIN/.exec(script)?.[1]
    if (token === undefined) throw new Error('missing token in wrapper payload')
    const push = (data: string): void => { this.subscription.push({ type: ActionType.TerminalData, data }) }
    push('\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;管理员: C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07\x1b[?25h')
    push('PS D:\\Base\\general_dir> ')
    push('\x1b[?25l\x1b[93mpowershell \x1b[90m-NoProfile -NonInteractive -EncodedCommand \x1b[37mJABlAG4AdgA6A\x1b[?25h')
    push('\x1b[m\x1b[?25l')
    push('\x1b[93m\x1b[1;25Hpowershell \x1b[90m-NoProfile -NonInteractive -EncodedCommand \x1b[37mJABlAG4AdgA6AEQAUwBIAF8ASABPAE0ARQAgAD0AIAAnAC8AVQBzAGUAcgBzAC8A\x1b[?25h')
    push('\x1b[m')
    push(`DSH:${token}:BEGIN`)
    push('channel-ok')
    push('\r\n')
    push('host: SALTED_FISH  mem: 15.9GB\r\n')
    push(`\r\nDSH:${token}:END:0`)
    push('\r')
    push('\nPS D:\\Base\\general_dir>\x1b[1C')
    return { clientSeq: 1 }
  }
}

async function setupWindows(client = new FakeWindowsConPtyTerminal()) {
  const ctx = new Context()
  const local = resolve('tests', 'shell-alias')
  const runtime = {
    mapper: new WorkspacePathMapper(local, '/D:/Base/general_dir', 'windows'),
    runtimeRoot: '/tmp/dsh/test',
    clientId: 'test-client',
    remoteOs: 'windows',
    getClient: async () => client as unknown as AhpClient,
  } as unknown as RemoteSshRuntime
  ctx.provide('remoteSsh', runtime)
  await ctx.plugin(RemoteSshShellExecutor, {
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 2000,
    outputMaxBytes: 1024,
    maxOutputMaxBytes: 4096,
    shellCommand: 'pwsh',
  })
  return { ctx, client, local }
}

describe('RemoteSshShellExecutor', () => {
  it('projects AHP terminal command actions into a ShellRunResult', async () => {
    const { ctx, client, local } = await setup()
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: 'printf remote-output',
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))).result()
    expect(result).toMatchObject({ exitCode: 7, signal: null, timedOut: false, aborted: false })
    expect(result.stdout).toEqual({ text: 'remote-output\r\n', truncated: false })
    expect(result.stderr).toEqual({ text: '', truncated: false })
    expect(client.writes).toHaveLength(1)
    expect(client.disposed).toBe(true)
  })

  it('rejects restrictive modes rather than pretending a remote shell is confined', async () => {
    const { ctx, local } = await setup()
    await expect((async () => {
      const execution = await ctx.shell.execute(ctx.shell.resolve({
        command: 'true',
        workdir: local,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: local },
      }))
      return execution.result()
    })()).rejects.toThrow(/cannot confine arbitrary remote commands/)
  })
})

describe('RemoteSshShellExecutor on Windows ConPTY streams', () => {
  it('completes from the production ConPTY stream whose RS/US framing was stripped', async () => {
    const { ctx, client, local } = await setupWindows()
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: '"channel-ok"',
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))).result()
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false })
    expect(result.stdout).toEqual({ text: 'channel-ok\r\nhost: SALTED_FISH  mem: 15.9GB\r\n\r\n', truncated: false })
    expect(client.writes).toHaveLength(1)
    expect(client.writes[0]).toMatch(/command-[0-9a-f-]{36}\.ps1$/)
    expect(client.disposed).toBe(true)
  })

  it('still completes when the framing controls survive a Windows pipeline', async () => {
    const client = new class extends FakeWindowsConPtyTerminal {
      override dispatch(channel: string, action: { data: string }): { clientSeq: number } {
        const encoded = /EncodedCommand ([A-Za-z0-9=+/]+)/.exec(action.data)?.[1]
        const script = Buffer.from(encoded!, 'base64').toString('utf16le')
        const token = /DSH:([0-9a-f-]{36}):BEGIN/.exec(script)![1]!
        this.subscription.push({ type: ActionType.TerminalData, data: `\x1eDSH:${token}:BEGIN\x1fframed-ok\r\n\x1eDSH:${token}:END:2\x1f` })
        return { clientSeq: 1 }
      }
    }()
    const { ctx, local } = await setupWindows(client)
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: "'framed-ok'",
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))).result()
    expect(result).toMatchObject({ exitCode: 2 })
    expect(result.stdout).toEqual({ text: 'framed-ok\r\n', truncated: false })
  })

  it('rejects a Windows exit marker whose status is not numeric', async () => {
    const client = new class extends FakeWindowsConPtyTerminal {
      override dispatch(channel: string, action: { data: string }): { clientSeq: number } {
        const encoded = /EncodedCommand ([A-Za-z0-9=+/]+)/.exec(action.data)?.[1]
        const script = Buffer.from(encoded!, 'base64').toString('utf16le')
        const token = /DSH:([0-9a-f-]{36}):BEGIN/.exec(script)![1]!
        this.subscription.push({ type: ActionType.TerminalData, data: `DSH:${token}:BEGINbad\r\nDSH:${token}:END:x` })
        return { clientSeq: 1 }
      }
    }()
    const { ctx, local } = await setupWindows(client)
    await expect((async () => {
      const execution = await ctx.shell.execute(ctx.shell.resolve({
        command: "'bad'",
        workdir: local,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
      }))
      return execution.result()
    })()).rejects.toThrow(/invalid exit marker/)
  })
})

describe('POSIX marker echo safety', () => {
  it('does not start capture on the printable echo of the typed POSIX invocation', async () => {
    // The terminal echoes the typed line verbatim: the marker text appears
    // with the escapes spelled printable (`\036…\037`), never as control
    // bytes. Capture must start only at the real framed marker.
    class EchoThenExecute extends FakeTerminalAhp {
      override dispatch(_channel: string, action: { data: string }) {
        const token = /DSH:([0-9a-f-]+):BEGIN/.exec(action.data)?.[1]
        if (token === undefined) throw new Error('missing output marker')
        this.subscription.push({ type: ActionType.TerminalData, data: `printf '\\036DSH:${token}:BEGIN\\037'; env 'bash' '/tmp/x' < /dev/null\r\n` })
        this.subscription.push({ type: ActionType.TerminalData, data: `\x1eDSH:${token}:BEGIN\x1freal-output` })
        this.subscription.push({ type: ActionType.TerminalData, data: `\x1eDSH:${token}:END:3\x1f` })
        return { clientSeq: 1 }
      }
    }
    const client = new EchoThenExecute()
    const ctx = new Context()
    const local = resolve('tests', 'shell-alias')
    const runtime = {
      mapper: new WorkspacePathMapper(local, '/srv/project'),
      runtimeRoot: '/tmp/dsh/test',
      clientId: 'test-client',
      getClient: async () => client as unknown as AhpClient,
    } as unknown as RemoteSshRuntime
    ctx.provide('remoteSsh', runtime)
    await ctx.plugin(RemoteSshShellExecutor, {
      defaultTimeoutMs: 1000,
      maxTimeoutMs: 2000,
      outputMaxBytes: 1024,
      maxOutputMaxBytes: 4096,
      shellCommand: 'bash',
    })
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: 'printf real-output',
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))).result()
    expect(result).toMatchObject({ exitCode: 3 })
    expect(result.stdout).toEqual({ text: 'real-output', truncated: false })
  })
})
