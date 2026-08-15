/** One-SSH attachment to a persistent remote dsh-host plus a local observer gateway. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { quotePosix } from './index.ts'

export const DEFAULT_DSH_BACKEND_PORT = 32120
const COOKIE_PREFIX = 'dsh_remote_backend_'

export interface RemoteBackendConfig {
  sshExecutable: string
  sshArgs: string[]
  sshTarget: string
  remotePort: number
  startupTimeoutMs: number
  localUiPort: number
}

export interface RemoteBackendAttachment {
  /** Bootstrap URL; the gateway exchanges its query token for an HttpOnly cookie. */
  url: string
  localPort: number
  remotePort: number
  dispose(): Promise<void>
}

/** Build the remote half of the single persistent SSH connection. */
export function buildDshBackendCommand(remotePort: number): string {
  if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`dsh-remote-ssh: invalid Backend port ${String(remotePort)}`)
  }
  return [
    'set -eu',
    'dsh_host="$HOME/.dsh-host/bin/dsh-host"',
    'if [ ! -x "$dsh_host" ]; then dsh_host="$(command -v dsh-host || true)"; fi',
    'if [ -z "$dsh_host" ]; then printf \'dsh-remote-ssh: dsh-host is not installed\\n\' >&2; exit 127; fi',
    'dsh_node="$HOME/.dsh-host/runtime/current/bin/node"',
    'if [ ! -x "$dsh_node" ]; then dsh_node="$(command -v node || true)"; fi',
    'if [ -z "$dsh_node" ]; then printf \'dsh-remote-ssh: Node.js for dsh-host is not installed\\n\' >&2; exit 127; fi',
    'endpoint_dir="$HOME/.dsh-host/instances/dsh-remote-ssh"',
    'endpoint="$endpoint_dir/endpoint.json"',
    'mkdir -p "$endpoint_dir"',
    `"$dsh_host" --instance dsh-remote-ssh --port ${String(remotePort)} --endpoint-file "$endpoint" --startup-timeout 600`,
    'token_file="$("$dsh_node" -e \'const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(e.tokenFile)\' "$endpoint")"',
    'token="$(tr -d \'\\r\\n\' < "$token_file")"',
    'case "$token" in *[!0-9a-fA-F]*|"") printf \'dsh-remote-ssh: invalid dsh-host connection token\\n\' >&2; exit 1;; esac',
    'printf \'DSH_REMOTE_BACKEND_READY %s\\n\' "$token"',
    'while IFS= read -r dsh_control; do [ "$dsh_control" = stop ] && exit 0; done',
  ].join('\n')
}

/** Own the SSH process, local forward, credential injection, and observer URL. */
export class RemoteDshBackend implements RemoteBackendAttachment {
  readonly localPort: number
  readonly remotePort: number
  readonly url: string

  private disposed = false

  private constructor(
    private readonly ssh: ChildProcessWithoutNullStreams,
    private readonly gateway: Server,
    localPort: number,
    remotePort: number,
    gatewayToken: string,
    private readonly sockets: Set<Duplex>,
  ) {
    this.localPort = localPort
    this.remotePort = remotePort
    this.url = `http://127.0.0.1:${String(localPort)}/?tkn=${encodeURIComponent(gatewayToken)}`
  }

  get alive(): boolean {
    return !this.disposed && this.ssh.exitCode === null && this.gateway.listening
  }

  static async open(config: RemoteBackendConfig): Promise<RemoteDshBackend> {
    const forwardPort = await reservePort()
    const ssh = spawn(config.sshExecutable, [
      ...config.sshArgs,
      '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${String(forwardPort)}:127.0.0.1:${String(config.remotePort)}`,
      config.sshTarget,
      buildDshBackendCommand(config.remotePort),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    let remoteToken: string
    try {
      remoteToken = await waitForBackendReady(ssh, config.startupTimeoutMs)
      await waitForPort(forwardPort, ssh, 15_000)
    } catch (error) {
      ssh.kill()
      throw error
    }

    const gatewayToken = randomBytes(32).toString('hex')
    const cookieName = `${COOKIE_PREFIX}${gatewayToken.slice(0, 16)}`
    const sockets = new Set<Duplex>()
    const gateway = createGateway({
      localUiPort: config.localUiPort,
      forwardPort,
      remoteToken,
      gatewayToken,
      cookieName,
      sockets,
    })
    try {
      await listenLoopback(gateway)
    } catch (error) {
      ssh.kill()
      throw error
    }
    const address = gateway.address()
    if (address === null || typeof address === 'string') throw new Error('dsh-remote-ssh: observer gateway has no TCP address')
    return new RemoteDshBackend(ssh, gateway, address.port, config.remotePort, gatewayToken, sockets)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try { this.ssh.stdin.end('stop\n') } catch {}
    const closed = new Promise<void>(resolve => { this.gateway.close(() => { resolve() }) })
    this.gateway.closeAllConnections()
    for (const socket of this.sockets) socket.destroy()
    const sshClosed = waitForChildClose(this.ssh, 2_000).then(closedCleanly => {
      if (!closedCleanly) this.ssh.kill()
    })
    await Promise.all([closed, sshClosed])
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
  // The gateway is the browser's same-origin authority. Rebase its browser
  // marker to the loopback upstream authority so Harness' DNS-rebinding fence
  // still validates the request after proxying.
  if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${String(port)}`
  if (remote) headers['x-dsh-host-token'] = remoteToken
  return headers
}

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

async function waitForBackendReady(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      operation()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout = (stdout + chunk.toString('utf8')).slice(-1024 * 1024)
      const match = /(?:^|\n)DSH_REMOTE_BACKEND_READY ([0-9a-fA-F]{64})(?:\r?\n|$)/.exec(stdout)
      const token = match?.[1]
      if (token !== undefined) finish(() => { resolve(token) })
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024) })
    child.once('error', error => { finish(() => { reject(error) }) })
    child.once('close', code => {
      finish(() => { reject(new Error(`dsh-remote-ssh: Backend SSH exited ${String(code)} before readiness${stderr.trim() ? `\n${stderr.trim()}` : ''}`)) })
    })
    const timer = setTimeout(() => {
      finish(() => { reject(new Error(`dsh-remote-ssh: Backend startup timed out after ${String(timeoutMs)}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`)) })
    }, timeoutMs)
  })
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('could not reserve a TCP port')); return }
      server.close(error => { if (error) reject(error); else resolve(address.port) })
    })
  })
}

async function waitForPort(port: number, child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dsh-remote-ssh: Backend SSH exited ${String(child.exitCode)} before the tunnel opened`)
    const connected = await new Promise<boolean>(resolve => {
      const socket = new Socket()
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) })
    })
    if (connected) return
    if (Date.now() >= deadline) throw new Error(`dsh-remote-ssh: Backend tunnel did not open within ${String(timeoutMs)}ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

async function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('close', onClose); resolve(false) }, timeoutMs)
    const onClose = (): void => { clearTimeout(timer); resolve(true) }
    child.once('close', onClose)
  })
}
