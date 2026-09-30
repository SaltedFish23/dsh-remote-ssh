import type { AhpClient } from '@microsoft/agent-host-protocol/client'
import { ClientClosedError, TransportError, type ConnectionState } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import RemoteSshRuntime, {
  SSH_KEEPALIVE_ARGS,
  buildSshCommandArgs,
  type AhpConnection,
  type RemoteSshLinkEvent,
} from '../src/transport/runtime.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Minimal AHP client double: publishes its own state transitions and rejects
 * requests once closed, which is exactly the contract the runtime relies on.
 * `pingBehavior` drives the protocol-level liveness probe: 'ok' answers,
 * 'hang' never settles (half-open path), and an Error instance rejects.
 */
class FakeClient {
  pingBehavior: 'ok' | 'hang' | Error = 'ok'
  pings = 0
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

  async ping(): Promise<void> {
    this.pings += 1
    if (this.pingBehavior === 'hang') return new Promise<void>(() => {})
    if (this.pingBehavior instanceof Error) throw this.pingBehavior
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

  it('notices a link that closed without any request and heals in the background', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients, new OpaqueClient())
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.close()
      await flushBackground()

      expect(runtime.connected).toBe(true)
      expect(clients).toHaveLength(2)
      const second = await runtime.getConnection()
      expect(second.client).toBe(clients[1])
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

  it('heals a dead link in the background without a consumer request', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()
      expect(clients).toHaveLength(1)

      clients[0]!.close()
      await flushBackground()

      expect(clients).toHaveLength(2)
      const second = await runtime.getConnection()
      expect(second.client).toBe(clients[1])
      expect(runtime.connected).toBe(true)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('lets a concurrent consumer join the background recovery', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.close()
      const joined = runtime.getConnection()
      await flushBackground()

      const settled = await runtime.getConnection()
      expect(await joined).toBe(settled)
      expect(clients).toHaveLength(2)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('keeps the next consumer call working after a failed background bootstrap', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    let failNextOpen = false
    openFactory = () => {
      if (failNextOpen) {
        failNextOpen = false
        throw new Error('ssh: connect timed out')
      }
      return trackClients(clients)
    }
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      failNextOpen = true
      clients[0]!.close()
      await flushBackground()
      expect(clients).toHaveLength(1)

      const second = await runtime.getConnection()
      expect(second.client).toBe(clients[1])
      expect(clients).toHaveLength(2)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })
})

/** Let background recovery microtasks (and one macrotask) settle. */
async function flushBackground(): Promise<void> {
  await new Promise<void>(resolvePromise => { setTimeout(resolvePromise, 0) })
}

describe('RemoteSshRuntime link state push', () => {
  it('reports connected and pushes reconnecting → connected when the link heals', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()
      expect(runtime.state).toBe('connected')

      const events: RemoteSshLinkEvent[] = []
      runtime.onStateChange(event => { events.push(event) })

      clients[0]!.close()
      await flushBackground()

      expect(events).toEqual([{ state: 'reconnecting' }, { state: 'connected' }])
      expect(runtime.state).toBe('connected')
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('carries the failure diagnostic while recovery retries', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    openFactory = () => {
      opens += 1
      if (opens === 1) return trackClients(clients)
      throw new Error('ssh: network unreachable')
    }
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      const events: RemoteSshLinkEvent[] = []
      runtime.onStateChange(event => { events.push(event) })

      clients[0]!.close()
      await flushBackground()

      expect(events).toEqual([
        { state: 'reconnecting' },
        { state: 'reconnecting', error: 'ssh: network unreachable' },
      ])
      expect(runtime.state).toBe('reconnecting')
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('marks a never-connected runtime failed, then connecting → connected on retry', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    openFactory = () => {
      opens += 1
      if (opens === 1) throw new Error('ssh: could not resolve hostname test-host')
      return trackClients(clients)
    }
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await flushBackground()
      expect(runtime.state).toBe('failed')

      const events: RemoteSshLinkEvent[] = []
      runtime.onStateChange(event => { events.push(event) })

      await runtime.getConnection()
      expect(events).toEqual([{ state: 'connecting' }, { state: 'connected' }])
      expect(runtime.state).toBe('connected')
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('publishes disposed on teardown and accepts late unsubscription', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
    const runtime = ctx.remoteSsh
    await runtime.getConnection()

    const events: RemoteSshLinkEvent[] = []
    const unsubscribe = runtime.onStateChange(event => { events.push(event) })

    await ctx.fiber.dispose()
    openFactory = undefined

    expect(events).toEqual([{ state: 'disposed' }])
    expect(runtime.state).toBe('disposed')
    expect(() => unsubscribe()).not.toThrow()
  })

  it('stops delivering events after unsubscription', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      const events: RemoteSshLinkEvent[] = []
      const unsubscribe = runtime.onStateChange(event => { events.push(event) })
      unsubscribe()

      clients[0]!.close()
      await flushBackground()
      expect(events).toEqual([])
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('isolates a throwing listener from other subscribers and the link', async () => {
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, { sshTarget: 'test-host' })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      const events: RemoteSshLinkEvent[] = []
      runtime.onStateChange(() => { throw new Error('listener bug') })
      runtime.onStateChange(event => { events.push(event) })

      clients[0]!.close()
      await flushBackground()

      expect(events).toEqual([{ state: 'reconnecting' }, { state: 'connected' }])
      expect(clients).toHaveLength(2)
      expect(runtime.state).toBe('connected')
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })
})

describe('RemoteSshRuntime recovery backoff', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function fakeTimers(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  }

  /** setImmediate stays real, so one macrotask drains all pending microtasks. */
  async function flushAsync(): Promise<void> {
    await new Promise<void>(resolvePromise => { setImmediate(resolvePromise) })
  }

  it('retries a failed bootstrap with exponential backoff until it heals', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    openFactory = () => {
      opens += 1
      if (opens === 2) throw new Error('ssh: connect timed out')
      return trackClients(clients)
    }
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 5_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()
      expect(opens).toBe(1)

      clients[0]!.close()
      await flushAsync()
      expect(opens).toBe(2)
      expect(clients).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(499)
      await flushAsync()
      expect(opens).toBe(2)

      await vi.advanceTimersByTimeAsync(1)
      await flushAsync()
      expect(opens).toBe(3)
      expect(clients).toHaveLength(2)
      expect((await runtime.getConnection()).client).toBe(clients[1])
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('caps the backoff delay at the configured maximum', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    let healthy = true
    openFactory = () => {
      opens += 1
      if (healthy) {
        healthy = false
        return trackClients(clients)
      }
      throw new Error('ssh: network unreachable')
    }
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 5_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()
      expect(opens).toBe(1)

      clients[0]!.close()
      // Attempts at t = 0, 500, 1500, 3500, 7500, 12500, 17500 with sleeps
      // 500, 1000, 2000, 4000, then capped at 5000.
      await vi.advanceTimersByTimeAsync(20_000)
      await flushAsync()
      expect(opens).toBe(8)

      await vi.advanceTimersByTimeAsync(2_499)
      await flushAsync()
      expect(opens).toBe(8)

      await vi.advanceTimersByTimeAsync(1)
      await flushAsync()
      expect(opens).toBe(9)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('lets a consumer call bypass the backoff sleep, and the loop adopts it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    let failing = false
    openFactory = () => {
      opens += 1
      if (failing) throw new Error('ssh: down')
      return trackClients(clients)
    }
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 5_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      failing = true
      clients[0]!.close()
      await flushAsync()
      expect(opens).toBe(2)

      failing = false
      const user = await runtime.getConnection()
      expect(user.client).toBe(clients[1])
      expect(opens).toBe(3)

      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsync()
      expect(opens).toBe(3)
      expect(clients).toHaveLength(2)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('resets the backoff after a healed link dies again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    let opens = 0
    openFactory = () => {
      opens += 1
      if (opens === 2) throw new Error('ssh: connect timed out')
      return trackClients(clients)
    }
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 5_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.close()
      await flushAsync()
      expect(opens).toBe(2)
      await vi.advanceTimersByTimeAsync(500)
      await flushAsync()
      expect(clients).toHaveLength(2)
      expect(opens).toBe(3)

      clients[1]!.close()
      await flushAsync()
      expect(clients).toHaveLength(3)
      expect(opens).toBe(4)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })
})

describe('RemoteSshRuntime heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function fakeTimers(): void {
    // Fake only the plain timers the heartbeat uses, so cordis fiber
    // scheduling keeps running on real macrotasks.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  }

  it('declares the link stale when a pong misses the heartbeat deadline', async () => {
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 60_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.pingBehavior = 'hang'
      await vi.advanceTimersByTimeAsync(30_000)
      expect(clients[0]!.pings).toBe(1)
      expect(clients).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(59_999)
      expect(clients).toHaveLength(1)

      // Deadline expired: probing stopped and the background recovery
      // opened a replacement without any consumer request.
      await vi.advanceTimersByTimeAsync(1)
      expect(clients).toHaveLength(2)
      expect(clients[0]!.pings).toBe(1)

      const second = await runtime.getConnection()
      expect(second.client).toBe(clients[1])
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('declares the link dead at the next tick when ping rejects', async () => {
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 60_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.pingBehavior = new Error('connection reset')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(clients[0]!.pings).toBe(1)
      expect(clients).toHaveLength(2)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('keeps a healthy link open across many answered pings', async () => {
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 60_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      await vi.advanceTimersByTimeAsync(5 * 30_000)
      expect(clients[0]!.pings).toBe(5)
      expect(runtime.connected).toBe(true)
      expect(clients).toHaveLength(1)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('stops probing once the heartbeat has declared the link dead', async () => {
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 60_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.pingBehavior = new Error('connection reset')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(clients).toHaveLength(2)

      // The replacement link owns the next probes; the dead one is silent.
      await vi.advanceTimersByTimeAsync(3 * 30_000)
      expect(clients[0]!.pings).toBe(1)
      expect(clients[1]!.pings).toBe(3)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
  })

  it('does not probe a link that watch() already reported closed', async () => {
    fakeTimers()
    const ctx = new Context()
    const clients: FakeClient[] = []
    openFactory = () => trackClients(clients)
    try {
      await ctx.plugin(TestRuntime, {
        sshTarget: 'test-host',
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 60_000,
      })
      const runtime = ctx.remoteSsh
      await runtime.getConnection()

      clients[0]!.close()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(clients[0]!.pings).toBe(0)
      expect(clients).toHaveLength(2)
      expect(clients[1]!.pings).toBe(1)
      expect(runtime.connected).toBe(true)
    } finally {
      openFactory = undefined
      await ctx.fiber.dispose()
    }
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
