import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import RemoteDshHostClient from '../src/backend/client.ts'

const servers: Server[] = []
const upgradedSockets = new Set<Duplex>()

afterEach(async () => {
  for (const socket of upgradedSockets) socket.destroy()
  upgradedSockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})

describe('UI-neutral Host client', () => {
  it('invokes an extension with Host authentication and the shared envelope', async () => {
    const server = createServer(async (req, res) => {
      expect(req.headers['x-dsh-host-token']).toBe('secret')
      expect(req.url).toBe('/api/example/run')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string; payload: unknown }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: request.payload } }))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')
    const client = new RemoteDshHostClient({
      origin: `http://127.0.0.1:${String(address.port)}`,
      requestHeaders: () => ({ 'x-dsh-host-token': 'secret' }),
      webSocketUrl: path => `ws://127.0.0.1:${String(address.port)}${path}?tkn=secret`,
    })
    await expect(client.invoke('example', 'run', { answer: 42 })).resolves.toMatchObject({
      result: { ok: true, value: { args: { answer: 42 } } },
    })
  })

  it('consumes the Host WebSocket stream instead of the SSE fallback', async () => {
    const server = createServer()
    server.on('upgrade', (req, socket) => {
      upgradedSockets.add(socket)
      socket.once('close', () => { upgradedSockets.delete(socket) })
      expect(req.url).toBe('/api/events.host?tkn=secret')
      const key = req.headers['sec-websocket-key']
      if (typeof key !== 'string') throw new Error('missing WebSocket key')
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'))
      const message = JSON.stringify({
        type: 'server-request',
        rpcId: randomUUID(),
        method: 'stream/error',
        payload: { type: 'stream/error', error: { code: 'internal', message: 'finished', details: {} } },
      })
      socket.end(Buffer.concat([webSocketTextFrame(message), Buffer.from([0x88, 0x00])]))
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')
    const client = new RemoteDshHostClient({
      origin: `http://127.0.0.1:${String(address.port)}`,
      requestHeaders: () => ({ 'x-dsh-host-token': 'secret' }),
      webSocketUrl: path => `ws://127.0.0.1:${String(address.port)}${path}?tkn=secret`,
    })
    const abort = new AbortController()
    const stream = client.events.host({}, abort.signal)[Symbol.asyncIterator]()

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { payload: { type: 'stream/error', error: { message: 'finished' } } },
    })
    abort.abort()
    await stream.return?.()
  })
})

function webSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  if (payload.byteLength < 126) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.byteLength, 2)
  return Buffer.concat([header, payload])
}
