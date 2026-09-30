import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { HttpSignaler, WebRtcConnection } from '../src/transport/webrtc'

const require = createRequire(import.meta.url)
const { InMemoryRelay, SignalingHTTP, createNodeHandler } = require('../examples/webrtc/http_signaling/relay.cjs')
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function relayServer(authorize = false, advertiseJoins = true) {
  const relay = new InMemoryRelay()
  const protocol = new SignalingHTTP(relay)
  if (!advertiseJoins) {
    const handle = protocol.handle.bind(protocol)
    protocol.handle = async (request: { method: string }) => {
      const response = await handle(request)
      if (request.method === 'PUT') delete response.headers?.['X-Magpie-Join-Announcements']
      return response
    }
  }
  const handler = createNodeHandler(protocol)
  const server = createServer((req, res) => {
    if (authorize && req.headers.authorization !== 'Bearer refreshed') {
      res.writeHead(401).end()
      return
    }
    void handler(req, res)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP server')
  return { baseUrl: `http://127.0.0.1:${address.port}/signal`, relay }
}

describe('HTTP signaling interoperability contract', () => {
  it('caches join announcements for later peers without repeating them', async () => {
    const { baseUrl } = await relayServer()
    const room = Buffer.from('cached').toString('base64url')
    const peer = (id: string) => `${baseUrl}/sessions/${room}/peers/${Buffer.from(id).toString('base64url')}`
    const put = (id: string, hello: string) => fetch(peer(id), { method: 'PUT', body: hello })
    const inbox = async (id: string, after = 0) => {
      const response = await fetch(peer(id) + `/messages?after=${after}&wait=0`)
      return { status: response.status, body: await response.text() }
    }
    const first = await put('a', 'hello-a')
    expect(first.headers.get('X-Magpie-Join-Announcements')).toBe('1')
    expect((await inbox('a')).status).toBe(204)
    await put('b', 'hello-b')
    expect((await inbox('a')).body).toBe('hello-b')
    expect((await inbox('b')).body).toBe('hello-a')
    await put('c', 'hello-c')
    expect((await inbox('c')).body).toBe('hello-a')
    expect((await inbox('c', 1)).body).toBe('hello-b')
    expect((await inbox('a', 1)).body).toBe('hello-c')
    await put('b', 'hello-b')
    expect((await inbox('a', 2)).status).toBe(204)
  })

  it('registers one cached hello and makes no periodic POST while alone', async () => {
    const { baseUrl, relay } = await relayServer()
    const sent: Uint8Array[] = []
    const originalSend = relay.send.bind(relay)
    relay.send = (...args: Parameters<typeof relay.send>) => {
      sent.push(args[3])
      return originalSend(...args)
    }
    const conn = await WebRtcConnection.withHttp(baseUrl, 'quiet', {
      pollWait: 0.2, webrtcOptions: { stunServers: [] },
    })
    try {
      expect(await conn.connect(1.3)).toBe(false)
      const room = Buffer.from('quiet').toString('base64url')
      const participant = Buffer.from((conn as unknown as { _signaler: HttpSignaler })._signaler.participantId).toString('base64url')
      expect(relay.rooms.get(room)?.get(participant)?.announcement?.length).toBeGreaterThan(0)
      expect(sent).toEqual([])
    } finally {
      await conn.disconnect()
    }
  })

  it('falls back to periodic hello POSTs when the relay lacks the join header', async () => {
    const { baseUrl, relay } = await relayServer(false, false)
    const sent: Uint8Array[] = []
    const originalSend = relay.send.bind(relay)
    relay.send = (...args: Parameters<typeof relay.send>) => {
      sent.push(args[3])
      return originalSend(...args)
    }
    const conn = await WebRtcConnection.withHttp(baseUrl, 'legacy', {
      pollWait: 0.2, webrtcOptions: { stunServers: [] },
    })
    try {
      expect(await conn.connect(1.3)).toBe(false)
      expect(sent.length).toBeGreaterThan(0)
    } finally {
      await conn.disconnect()
    }
  })

  it('routes opaque bytes, preserves UTF-8 IDs, refreshes headers, and releases peers', async () => {
    const { baseUrl, relay } = await relayServer(true)
    let providerCalls = 0
    const options = {
      participantId: 'peer / α',
      headers: { Authorization: 'Bearer expired' },
      headersProvider: () => { providerCalls++; return { Authorization: 'Bearer refreshed' } },
      pollWait: 0.2,
    }
    const a = await HttpSignaler.create(baseUrl, 'room with / slash', options)
    const b = await HttpSignaler.create(baseUrl, 'room with / slash', {
      headers: { Authorization: 'Bearer refreshed' }, pollWait: 0.2,
    })
    const encodedRoom = Buffer.from('room with / slash').toString('base64url')
    const encodedPeer = Buffer.from('peer / α').toString('base64url')
    expect(relay.rooms.get(encodedRoom)?.has(encodedPeer)).toBe(true)

    let c: HttpSignaler | null = null
    try {
      const received = new Promise<Uint8Array>(resolve => b.subscribe(resolve))
      a.publish(Uint8Array.from([0, 255, 20]))
      expect(Array.from(await received)).toEqual([0, 255, 20])
      expect(providerCalls).toBeGreaterThanOrEqual(2)
      c = await HttpSignaler.create(baseUrl, 'room with / slash', {
        headers: { Authorization: 'Bearer refreshed' },
      })
      expect(relay.rooms.get(encodedRoom)?.size).toBe(3)
    } finally {
      await a.disconnect()
      await b.disconnect()
      await c?.disconnect()
    }
    expect(relay.rooms.has(encodedRoom)).toBe(false)
  })

  it('supports cursor replay, duplicate POST suppression, and the connection factory', async () => {
    const { baseUrl } = await relayServer()
    const session = Buffer.from('call').toString('base64url')
    const aUrl = `${baseUrl}/sessions/${session}/peers/YQ`
    const bUrl = `${baseUrl}/sessions/${session}/peers/Yg`
    expect((await fetch(aUrl, { method: 'PUT' })).status).toBe(204)
    expect((await fetch(bUrl, { method: 'PUT' })).status).toBe(204)
    const headers = { 'X-Magpie-Message-Id': 'message-1' }
    expect((await fetch(aUrl + '/messages', { method: 'POST', headers, body: 'first' })).status).toBe(204)
    expect((await fetch(aUrl + '/messages', { method: 'POST', headers, body: 'first' })).status).toBe(204)
    const first = await fetch(bUrl + '/messages?after=0&wait=0')
    expect(first.headers.get('X-Magpie-Sequence')).toBe('1')
    expect(await first.text()).toBe('first')
    const replay = await fetch(bUrl + '/messages?after=0&wait=0')
    expect(replay.headers.get('X-Magpie-Sequence')).toBe('1')
    expect((await fetch(bUrl + '/messages?after=1&wait=0')).status).toBe(204)
    await fetch(aUrl, { method: 'DELETE' })
    await fetch(bUrl, { method: 'DELETE' })

    const conn = await WebRtcConnection.withHttp(baseUrl + '///', 'factory', { webrtcOptions: { stunServers: [] } })
    expect(conn.sessionId).toBe('factory')
    await conn.disconnect()
  })

  it('rejoins after a lost mailbox and retries the queued message', async () => {
    const { baseUrl } = await relayServer()
    const a = await HttpSignaler.create(baseUrl, 'renew', { pollWait: 0.2 })
    const b = await HttpSignaler.create(baseUrl, 'renew', { pollWait: 0.2 })
    try {
      const session = Buffer.from('renew').toString('base64url')
      const peer = Buffer.from(a.participantId).toString('base64url')
      expect((await fetch(`${baseUrl}/sessions/${session}/peers/${peer}`, { method: 'DELETE' })).status).toBe(204)
      const received = new Promise<Uint8Array>(resolve => b.subscribe(resolve))
      a.publish(Uint8Array.from([1, 2, 3]))
      expect(Array.from(await received)).toEqual([1, 2, 3])
    } finally {
      await a.disconnect()
      await b.disconnect()
    }
  })
})
