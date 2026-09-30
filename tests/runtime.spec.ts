import type { AhpClient } from '@microsoft/agent-host-protocol/client'
import { ClientClosedError, TransportError, type ConnectionState } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import RemoteSshRuntime, {
  SSH_KEEPALIVE_ARGS,
  buildSshCommandArgs,
  type AhpConnection,
} from '../src/transport/runtime.ts'
import { describe, expect, it } from 'vitest'

/**
 * Minimal AHP client double: publishes its own state transitions and rejects
 * requests once closed, which is exactly the contract the runtime relies on.
 */
class FakeClient {
  private state: ConnectionState = { status: 'connected' }
  private readonly closedSignal: Promise<void>
  private notifyClosed!: () => void

  constructor() {
    this.closedSignal = new Promise<void>(resolvePromise => { this.notifyClosed = resolvePromise })
  }

  get connectionState(): ConnectionState { return this.state }

  async *stateChanges(): AsyncIterableIterator<ConnectionState> {
    yield this.state
    if (this.state.status !== 'closed') await this.closedSignal
    yield this.state
  }

  close(): void {
    if (this.state.status === 'closed') return
    this.state = {
      status: 'closed',
      reason: { type: 'transport', error: new TransportError('closed', 'transport closed') },
    }
    this.notifyClosed()
  }

  async shutdown(): Promise<void> { this.close() }

  async resourceResolve(params: { uri: string }): Promise<{ uri: string; type: 'directory' }> {
    if (this.state.status === 'closed') throw new ClientClosedError()
    return { uri: params.uri, type: 'directory' }
  }
}

/** A client whose local state view never reports the closure itself. */
class OpaqueClient extends FakeClient {
  override get connectionState(): ConnectionState { return { status: 'connected' } }
}

let openFactory: (() => AhpConnection) | undefined

/** Replaces the SSH/AHP bootstrap so the runtime's policy can be driven directly. */
class TestRuntime extends RemoteSshRuntime {
  protected override async open(): Promise<AhpConnection> {
    if (openFactory === undefined) throw new Error('test runtime has no open factory')
    return openFactory()
  }
}

function connection(client: FakeClient): AhpConnection {
  return { client: client as unknown as AhpClient, protocolVersion: '0.9.0' }
}

function trackClients(target: FakeClient[], client: FakeClient = new FakeClient()): AhpConnection {
  target.push(client)
  return connection(client)
}

describe('RemoteSshRuntime', () => {
  it('reuses a live Agent Host connection and reopens it once the link closes', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      const first = await runtime.getConnection()

      expect(first.client).toBe(clients[0])
      expect(runtime.connected).toBe(true)
      expect(await runtime.getConnection()).toBe(first)
      expect(clients).toHaveLength(1)

      clients[0]!.close()
      expect(runtime.connected).toBe(false)

      const second = await runtime.getConnection()
      expect(second).not.toBe(first)
      expect(clients).toHaveLength(2)
      await expect(second.client.resourceResolve({ uri: 'file:///srv' }))
        .resolves.toMatchObject({ uri: 'file:///srv' })
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('notices a link that closed without any request and reconnects on the next call', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients, new OpaqueClient())
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.close()
      await new Promise(resolvePromise => { setTimeout(resolvePromise, 0) })
      expect(runtime.connected).toBe(false)

      await runtime.getConnection()
      expect(clients).toHaveLength(2)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed startup on the next call instead of caching the rejection', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => { throw new Error('ssh: could not resolve hostname test-host') }
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await expect(runtime.getConnection()).rejects.toThrow(/could not resolve hostname/)

      openFactory = () => trackClients(clients)
      await expect(runtime.getConnection()).resolves.toMatchObject({ protocolVersion: '0.9.0' })
      expect(clients).toHaveLength(1)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('releases the Agent Host connection when the runtime is disposed', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
    const runtime = ctx.remoteSsh
    await runtime.getConnection()

    await ctx.fiber.dispose()
    openFactory = undefined

    expect(runtime.connected).toBe(false)
    expect(clients[0]!.connectionState.status).toBe('closed')
    await expect(runtime.getConnection()).rejects.toThrow(/disposing/)
  })
})

describe('SSH command args', () => {
  it('exposes keepalive options as well-formed -o pairs', () => {
    expect(SSH_KEEPALIVE_ARGS).toEqual([
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ])
  })

  it('builds one-shot command sessions with keepalive before the target', () => {
    const args = buildSshCommandArgs(['-i', '~/.ssh/id_ed25519'], 'dev-box', 'uptime')
    expect(args).toEqual([
      '-i', '~/.ssh/id_ed25519',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-T',
      'dev-box',
      'uptime',
    ])
  })

  it('keeps user args intact and does not mutate the input', () => {
    const userArgs = ['-i', '~/.ssh/key', '-p', '2222']
    const args = buildSshCommandArgs(userArgs, 'host', 'true')
    expect(args.slice(0, 4)).toEqual(userArgs)
    expect(args).toContain('-T')
    expect(args.at(-2)).toBe('host')
    expect(args.at(-1)).toBe('true')
    expect(userArgs).toEqual(['-i', '~/.ssh/key', '-p', '2222'])
  })
})
