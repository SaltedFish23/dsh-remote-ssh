/** Local Web asset server and same-origin proxy over a remote dsh-host tunnel. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  DEFAULT_DSH_HOST_PORT,
  RemoteDshHostTunnel,
  type RemoteDshHostTunnelConfig,
} from './tunnel.ts'

export { buildDshBackendCommand } from './install.ts'
export { RemoteDshHostTunnel } from './tunnel.ts'
export type { RemoteDshHostTunnelConfig } from './tunnel.ts'

export const DEFAULT_DSH_BACKEND_PORT = DEFAULT_DSH_HOST_PORT
const COOKIE_PREFIX = 'dsh_remote_backend_'

export interface RemoteWebProxyConfig extends RemoteDshHostTunnelConfig {
  localUiPort: number
}

export interface RemoteWebProxyAttachment {
  /** Bootstrap URL; the gateway exchanges its query token for an HttpOnly cookie. */
  url: string
  localPort: number
  remotePort: number
  dispose(): Promise<void>
}

/** Serve local Web assets and proxy the unchanged Host protocol on one origin. */
export class RemoteDshWebProxy implements RemoteWebProxyAttachment {
  readonly localPort: number
  readonly remotePort: number
  readonly url: string

  private disposed = false

  private constructor(
    private readonly tunnel: RemoteDshHostTunnel,
    private readonly gateway: Server,
    localPort: number,
    remotePort: number,
    gatewayToken: string,
    private readonly sockets: Set<Duplex>,
    private readonly ownsTunnel: boolean,
  ) {
    this.localPort = localPort
    this.remotePort = remotePort
    this.url = `http://127.0.0.1:${String(localPort)}/?tkn=${encodeURIComponent(gatewayToken)}`
  }

  get alive(): boolean {
    return !this.disposed && this.tunnel.alive && this.gateway.listening
  }

  static async open(config: RemoteWebProxyConfig): Promise<RemoteDshWebProxy> {
    const tunnel = await RemoteDshHostTunnel.open(config)
    try {
      return await this.attachInternal(tunnel, config.localUiPort, true)
    } catch (error) {
      await tunnel.dispose()
      throw error
    }
  }

  /** Add the browser same-origin proxy without taking ownership of the SSH tunnel. */
  static attach(tunnel: RemoteDshHostTunnel, localUiPort: number): Promise<RemoteDshWebProxy> {
    return this.attachInternal(tunnel, localUiPort, false)
  }

  private static async attachInternal(
    tunnel: RemoteDshHostTunnel,
    localUiPort: number,
    ownsTunnel: boolean,
  ): Promise<RemoteDshWebProxy> {
    const remoteToken = tunnel.requestHeaders()['x-dsh-host-token']
    if (remoteToken === undefined) throw new Error('dsh-remote-ssh: Host tunnel did not provide credentials')

    const gatewayToken = randomBytes(32).toString('hex')
    const cookieName = `${COOKIE_PREFIX}${gatewayToken.slice(0, 16)}`
    const sockets = new Set<Duplex>()
    const gateway = createGateway({
      localUiPort,
      forwardPort: tunnel.localPort,
      remoteToken,
      gatewayToken,
      cookieName,
      sockets,
    })
    try {
      await listenLoopback(gateway)
    } catch (error) { throw error }
    const address = gateway.address()
    if (address === null || typeof address === 'string') throw new Error('dsh-remote-ssh: Web proxy has no TCP address')
    return new RemoteDshWebProxy(tunnel, gateway, address.port, tunnel.remotePort, gatewayToken, sockets, ownsTunnel)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const closed = new Promise<void>(resolve => { this.gateway.close(() => { resolve() }) })
    this.gateway.closeAllConnections()
    for (const socket of this.sockets) socket.destroy()
    await Promise.all([closed, ...(this.ownsTunnel ? [this.tunnel.dispose()] : [])])
  }
}

interface GatewayOptions {
  localUiPort: number
  forwardPort: number
  remoteToken: string
  gatewayToken: string
  cookieName: string
  sockets: Set<Duplex>
}

function createGateway(options: GatewayOptions): Server {
  const server = createServer((req, res) => {
    if (exchangeToken(req, res, options.gatewayToken, options.cookieName)) return
    if (!cookieMatches(req, options.gatewayToken, options.cookieName)) return unauthorized(res)
    proxyHttp(req, res, proxyTarget(req, options), options.remoteToken)
  })
  server.on('upgrade', (req, socket, head) => {
    if (!cookieMatches(req, options.gatewayToken, options.cookieName)) { socket.destroy(); return }
    options.sockets.add(socket)
    socket.once('close', () => { options.sockets.delete(socket) })
    proxyUpgrade(req, socket, head, proxyTarget(req, options), options.remoteToken, options.sockets)
  })
  return server
}

function proxyTarget(req: IncomingMessage, options: GatewayOptions): { port: number; remote: boolean } {
  const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
  const remote = pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/dsh-host' || pathname.startsWith('/dsh-host/')
  return { port: remote ? options.forwardPort : options.localUiPort, remote }
}

function proxyHeaders(req: IncomingMessage, port: number, remote: boolean, remoteToken: string): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${String(port)}` }
  delete headers.cookie
  delete headers['proxy-connection']
  delete headers['x-dsh-host-token']
  if (remote) headers['x-dsh-host-token'] = remoteToken
  return headers
}

/** @deprecated Use RemoteWebProxyConfig. */
export type RemoteBackendConfig = RemoteWebProxyConfig
/** @deprecated Use RemoteWebProxyAttachment. */
export type RemoteBackendAttachment = RemoteWebProxyAttachment
/** @deprecated Use RemoteDshWebProxy. */
export { RemoteDshWebProxy as RemoteDshBackend }

function proxyHttp(req: IncomingMessage, res: ServerResponse, target: { port: number; remote: boolean }, remoteToken: string): void {
  const upstream = httpRequest({
    host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
    headers: proxyHeaders(req, target.port, target.remote, remoteToken),
  }, response => {
    const headers = { ...response.headers }
    delete headers['set-cookie']
    res.writeHead(response.statusCode ?? 502, headers)
    response.pipe(res)
  })
  upstream.once('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('remote backend unavailable')
  })
  req.pipe(upstream)
}

function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: { port: number; remote: boolean },
  remoteToken: string,
  sockets: Set<Duplex>,
): void {
  const upstream = httpRequest({
    host: '127.0.0.1', port: target.port, method: req.method, path: req.url,
    headers: proxyHeaders(req, target.port, target.remote, remoteToken),
  })
  upstream.once('upgrade', response => {
    const upstreamSocket = response.socket as Socket
    sockets.add(upstreamSocket)
    upstreamSocket.once('close', () => { sockets.delete(upstreamSocket) })
    socket.write(`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}\r\n`)
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
    }
    socket.write('\r\n')
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  upstream.once('response', response => {
    socket.end(`HTTP/1.1 ${String(response.statusCode ?? 502)} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`)
  })
  upstream.once('error', () => { socket.destroy() })
  upstream.end()
}

function exchangeToken(req: IncomingMessage, res: ServerResponse, expected: string, cookieName: string): boolean {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const supplied = url.searchParams.get('tkn')
  if (supplied === null) return false
  if (!safeEqual(expected, supplied)) { unauthorized(res); return true }
  url.searchParams.delete('tkn')
  const location = `${url.pathname}${url.search}${url.hash}`
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'set-cookie': `${cookieName}=${expected}; HttpOnly; SameSite=Strict; Path=/`,
  })
  res.end()
  return true
}

function cookieMatches(req: IncomingMessage, expected: string, cookieName: string): boolean {
  const cookies = (req.headers.cookie ?? '').split(';')
  const value = cookies.map(cookie => cookie.trim().split('=', 2)).find(([name]) => name === cookieName)?.[1]
  return safeEqual(expected, value)
}

function safeEqual(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('unauthorized')
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}
