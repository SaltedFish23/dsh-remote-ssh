/** UI-neutral client for the dsh-host HTTP/WebSocket protocol. */

import { randomUUID } from 'node:crypto'
import {
  AbstractApiClient,
  type IApiClient,
} from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'

export interface DshHostEndpoint {
  readonly origin: string
  requestHeaders(): Readonly<Record<string, string>>
  webSocketUrl(path: string): string
}

type SocketItem<F> =
  | { kind: 'frame'; envelope: RpcRequest<F> }
  | { kind: 'error'; error: Error }
  | { kind: 'end' }

interface Parser<F> { parse(value: unknown): F }

export interface HostExtensionResult<T = unknown> {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value?: T } | {
    ok: false
    error: { code: string; message: string; details: unknown }
  }
}

/**
 * The same client works in a terminal, daemon, test runner, or another UI.
 * Core domains use Harness' typed ApiClient; extension RPC uses invoke().
 */
export class RemoteDshHostClient extends AbstractApiClient {
  readonly api: IApiClient = this

  constructor(private readonly endpoint: DshHostEndpoint, timeoutMs?: number) {
    super(timeoutMs)
  }

  protected override resolveBase(): string {
    return this.endpoint.origin
  }

  protected doFetch(input: URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries(this.endpoint.requestHeaders())) headers.set(name, value)
    return globalThis.fetch(input, { ...init, headers })
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  async invoke<T = unknown>(
    namespace: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<HostExtensionResult<T>> {
    assertSegment(namespace, 'namespace')
    assertSegment(method, 'method')
    const rpcId = randomUUID()
    const response = await this.doFetch(new URL(`/api/${namespace}/${method}`, this.resolveBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args },
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`dsh-host extension RPC failed with HTTP ${String(response.status)}`)
    const value = await response.json() as HostExtensionResult<T>
    if (value.type !== 'server-response' || value.rpcId !== rpcId) {
      throw new Error('dsh-host extension RPC returned an invalid response envelope')
    }
    return value
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    signal.throwIfAborted()
    const socket = new WebSocket(this.endpoint.webSocketUrl(path))
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (event: MessageEvent): void => {
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        const full = serverRequestSchema.parse(JSON.parse(event.data)) as ServerRequest
        const frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        console.error(`[dsh-host] dropping malformed WebSocket frame on ${path}:`, error)
      }
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleError = (): void => {
      enqueue({ kind: 'error', error: new Error(`dsh-host WebSocket failed on ${path}`) })
    }
    const handleAbort = (): void => { socket.close() }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      for (;;) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          yield item.envelope
        }
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

function assertSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_$.-]+$/.test(value)) throw new Error(`dsh-host extension ${label} is invalid`)
}

export default RemoteDshHostClient
