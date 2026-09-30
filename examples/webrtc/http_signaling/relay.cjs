/** Copyable, MAGPIE-independent implementation of the HTTP signaling contract. */

class Mailbox {
  constructor() {
    this.messages = [] // [sequence, opaque Buffer]
    this.announcement = null // latest opaque join announcement
    this.nextSequence = 1
    this.seenIds = new Set()
    this.seenOrder = []
    this.lastSeen = Date.now()
    this.waiters = new Set()
  }

  remember(messageId) {
    if (this.seenIds.has(messageId)) return false
    this.seenIds.add(messageId)
    this.seenOrder.push(messageId)
    if (this.seenOrder.length > 256) this.seenIds.delete(this.seenOrder.shift())
    return true
  }
}

class InMemoryRelay {
  constructor({ leaseSeconds = 90 } = {}) {
    this.rooms = new Map()
    this.leaseMs = leaseSeconds * 1000
  }

  _prune() {
    const now = Date.now()
    for (const [session, room] of this.rooms) {
      for (const [peer, box] of room) {
        if (now - box.lastSeen > this.leaseMs) {
          room.delete(peer)
          for (const waiter of box.waiters) waiter(null)
        }
      }
      if (!room.size) this.rooms.delete(session)
    }
  }

  _enqueue(box, payload) {
    const message = [box.nextSequence++, Buffer.from(payload)]
    box.messages.push(message)
    for (const waiter of box.waiters) waiter(message)
  }

  join(session, peer, announcement = Buffer.alloc(0)) {
    this._prune()
    let room = this.rooms.get(session)
    if (!room) { room = new Map(); this.rooms.set(session, room) }
    let box = room.get(peer)
    if (!box) {
      box = new Mailbox()
      room.set(peer, box)
      for (const [otherPeer, otherBox] of room) {
        if (otherPeer !== peer && otherBox.announcement) this._enqueue(box, otherBox.announcement)
      }
    }
    box.lastSeen = Date.now()
    if (announcement.length && (!box.announcement || !box.announcement.equals(announcement))) {
      box.announcement = Buffer.from(announcement)
      for (const [otherPeer, otherBox] of room) {
        if (otherPeer !== peer) this._enqueue(otherBox, box.announcement)
      }
    }
    return true
  }

  leave(session, peer) {
    const room = this.rooms.get(session)
    const box = room?.get(peer)
    if (box) {
      room.delete(peer)
      for (const waiter of box.waiters) waiter(null)
    }
    if (room && !room.size) this.rooms.delete(session)
  }

  send(session, peer, messageId, payload) {
    this._prune()
    const room = this.rooms.get(session)
    const sender = room?.get(peer)
    if (!sender) return false
    sender.lastSeen = Date.now()
    if (!sender.remember(messageId)) return true
    for (const [otherPeer, box] of room) {
      if (otherPeer === peer) continue
      this._enqueue(box, payload)
    }
    return true
  }

  async receive(session, peer, after, wait, signal) {
    this._prune()
    const box = this.rooms.get(session)?.get(peer)
    if (!box) return null
    box.lastSeen = Date.now()
    while (box.messages.length && box.messages[0][0] <= after) box.messages.shift()
    if (box.messages.length) return box.messages[0]
    if (!wait) return [0, Buffer.alloc(0)]

    return new Promise(resolve => {
      let timer
      const finish = value => {
        clearTimeout(timer)
        box.waiters.delete(onMessage)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onMessage = message => {
        if (message === null || message[0] > after) finish(message)
      }
      const onAbort = () => finish(null)
      box.waiters.add(onMessage)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish([0, Buffer.alloc(0)]), wait * 1000)
      if (signal?.aborted) onAbort()
    })
  }
}

class SignalingHTTP {
  constructor(relay = new InMemoryRelay(), { maxMessageBytes = 1024 * 1024 } = {}) {
    this.relay = relay
    this.maxMessageBytes = maxMessageBytes
  }

  async handle({ method, path, query = '', headers = {}, body = Buffer.alloc(0), signal }) {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/')
    if (![4, 5].includes(parts.length) || parts[0] !== 'sessions' || parts[2] !== 'peers'
        || !parts[1] || !parts[3] || (parts.length === 5 && parts[4] !== 'messages')) {
      return { status: 404 }
    }
    const session = parts[1]
    const peer = parts[3]
    const messages = parts.length === 5
    if (method === 'PUT' && !messages) {
      if (body.length > this.maxMessageBytes) return { status: 413 }
      return {
        status: this.relay.join(session, peer, body) ? 204 : 409,
        headers: { 'X-Magpie-Join-Announcements': '1' },
      }
    }
    if (method === 'DELETE' && !messages) {
      this.relay.leave(session, peer)
      return { status: 204 }
    }
    if (method === 'POST' && messages) {
      if (body.length > this.maxMessageBytes) return { status: 413 }
      const id = headers['x-magpie-message-id'] ?? headers['X-Magpie-Message-Id']
      if (!id) return { status: 400 }
      return { status: this.relay.send(session, peer, String(id), body) ? 204 : 404 }
    }
    if (method === 'GET' && messages) {
      const params = new URLSearchParams(query)
      const after = Number(params.get('after') ?? '0')
      const wait = Number(params.get('wait') ?? '20')
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0 || wait > 30) {
        return { status: 400 }
      }
      const message = await this.relay.receive(session, peer, after, wait, signal)
      if (message === null) return { status: 404 }
      if (message[0] === 0) return { status: 204 }
      return {
        status: 200,
        body: message[1],
        headers: { 'Content-Type': 'application/octet-stream', 'X-Magpie-Sequence': String(message[0]) },
      }
    }
    return { status: 405 }
  }
}

/** Adapt the protocol to Node's IncomingMessage/ServerResponse (also Express). */
function createNodeHandler(protocol, { prefix = '/signal' } = {}) {
  return async (req, res) => {
    const controller = new AbortController()
    const onClose = () => controller.abort()
    res.once('close', onClose)
    try {
      const url = new URL(req.url, 'http://localhost')
      let path = url.pathname
      if (prefix && (path === prefix || path.startsWith(prefix + '/'))) {
        path = path.slice(prefix.length) || '/'
      }
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > protocol.maxMessageBytes) {
          res.writeHead(413, { 'Cache-Control': 'no-store', 'Content-Length': '0' })
          res.end()
          return
        }
        chunks.push(chunk)
      }
      const result = await protocol.handle({
        method: req.method, path, query: url.searchParams.toString(),
        headers: req.headers, body: Buffer.concat(chunks), signal: controller.signal,
      })
      if (res.destroyed) return
      const body = result.body ?? Buffer.alloc(0)
      res.writeHead(result.status, {
        'Cache-Control': 'no-store', 'Content-Length': String(body.length), ...result.headers,
      })
      res.end(body)
    } catch (error) {
      if (!res.destroyed) {
        console.error('HTTP signaling relay error:', error)
        res.writeHead(500, { 'Content-Length': '0' })
        res.end()
      }
    } finally {
      res.off('close', onClose)
    }
  }
}

module.exports = { InMemoryRelay, SignalingHTTP, createNodeHandler }
