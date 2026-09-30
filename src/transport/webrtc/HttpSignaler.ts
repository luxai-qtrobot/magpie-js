/** HTTP long-poll signaling compatible with MAGPIE's Python wire contract. */

import { getUniqueId } from '../../utils/common'
import { Logger } from '../../utils/logger'
import { WebRtcSignaler } from './WebRtcSignaler'

export interface HttpSignalerOptions {
  participantId?: string
  headers?: Record<string, string>
  /** Called before every request; returned values override fixed headers. */
  headersProvider?: () => Record<string, string> | Promise<Record<string, string>>
  /** Supply a fetch implementation for custom HTTP behavior or tests. */
  fetchImpl?: typeof fetch
  /** Browser fetch credentials policy, for example 'include' for cookies. */
  credentials?: RequestCredentials
  pollWait?: number // seconds, maximum 30
  requestTimeout?: number // seconds
}

type Outgoing = { id: string; payload: Uint8Array }

/** Encode UTF-8 bytes as unpadded URL-safe Base64, including non-ASCII IDs. */
function pathSegment(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let encoded = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    encoded += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (i + 1 < bytes.length) encoded += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (i + 2 < bytes.length) encoded += alphabet[c & 63]
  }
  return encoded
}

export class HttpSignaler extends WebRtcSignaler {
  private readonly _sessionId: string
  readonly participantId: string
  private readonly _peerUrl: string
  private readonly _messagesUrl: string
  private readonly _headers: Record<string, string>
  private readonly _headersProvider?: HttpSignalerOptions['headersProvider']
  private readonly _fetch: typeof fetch
  private readonly _credentials?: RequestCredentials
  private readonly _pollWait: number
  private readonly _requestTimeout: number
  private readonly _active = new Set<AbortController>()
  private readonly _stop = new AbortController()
  private readonly _outgoing: Outgoing[] = []
  private _callback: ((payload: Uint8Array) => void) | null = null
  private _cursor = 0
  private _announcement = new Uint8Array(0)
  private _supportsJoinAnnouncements = false
  private _closed = false
  private _sending = false
  private _polling = false

  private constructor(baseUrl: string, sessionId: string, options: HttpSignalerOptions) {
    super()
    const parsed = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new Error('baseUrl must be an http:// or https:// URL without a query or fragment')
    }
    if (!sessionId) throw new Error('sessionId must not be empty')
    const pollWait = options.pollWait ?? 20
    const requestTimeout = options.requestTimeout ?? 10
    if (!(pollWait > 0 && pollWait <= 30) || !(requestTimeout > 0)) {
      throw new Error('pollWait must be in (0, 30] and requestTimeout must be positive')
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('HttpSignaler requires fetch')

    this._sessionId = sessionId
    this.participantId = options.participantId || globalThis.crypto?.randomUUID?.() || getUniqueId()
    this._headers = { ...options.headers }
    this._headersProvider = options.headersProvider
    this._fetch = options.fetchImpl ?? fetchImpl.bind(globalThis)
    this._credentials = options.credentials
    this._pollWait = pollWait
    this._requestTimeout = requestTimeout
    this._peerUrl = `${baseUrl.replace(/\/+$/, '')}/sessions/${pathSegment(sessionId)}/peers/${pathSegment(this.participantId)}`
    this._messagesUrl = `${this._peerUrl}/messages`
  }

  /** Direct signaler users register immediately; withHttp registers with its hello on connect(). */
  static async create(
    baseUrl: string, sessionId: string, options: HttpSignalerOptions = {},
    registerOnCreate = true,
  ): Promise<HttpSignaler> {
    const signaler = new HttpSignaler(baseUrl, sessionId, options)
    if (registerOnCreate) await signaler._register()
    return signaler
  }

  get sessionId(): string { return this._sessionId }
  get supportsJoinAnnouncements(): boolean { return this._supportsJoinAnnouncements }

  async announce(payload: Uint8Array): Promise<boolean> {
    if (this._closed) throw new Error('HttpSignaler is disconnected')
    this._announcement = Uint8Array.from(payload)
    await this._register(false)
    return this._supportsJoinAnnouncements
  }

  publish(payload: Uint8Array): void {
    if (this._closed) throw new Error('HttpSignaler is disconnected')
    this._outgoing.push({ id: getUniqueId(), payload: Uint8Array.from(payload) })
    if (!this._sending) void this._sendLoop()
  }

  subscribe(callback: (payload: Uint8Array) => void): void {
    if (this._closed) throw new Error('HttpSignaler is disconnected')
    this._callback = callback
    if (!this._polling) void this._pollLoop()
  }

  unsubscribe(): void { this._callback = null }

  async disconnect(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this._callback = null
    this._outgoing.length = 0
    this._stop.abort()
    for (const controller of this._active) controller.abort()
    try {
      await this._request('DELETE', this._peerUrl)
    } catch {
      // The relay may already be unavailable; its lease will expire.
    }
  }

  private async _request(method: string, url: string, options: RequestInit = {}, timeout = this._requestTimeout): Promise<Response> {
    if (this._closed && method !== 'DELETE') throw new Error('HttpSignaler is disconnected')
    const headers = new Headers(this._headers)
    if (this._headersProvider) {
      const provided = await this._headersProvider()
      for (const [name, value] of Object.entries(provided ?? {})) headers.set(name, value)
    }
    if (this._closed && method !== 'DELETE') throw new Error('HttpSignaler is disconnected')
    new Headers(options.headers).forEach((value, name) => headers.set(name, value))
    const controller = new AbortController()
    this._active.add(controller)
    const timer = setTimeout(() => controller.abort(), timeout * 1000)
    try {
      return await this._fetch(url, {
        ...options, method, headers, signal: controller.signal, credentials: this._credentials,
      })
    } finally {
      clearTimeout(timer)
      this._active.delete(controller)
    }
  }

  private async _register(resetCursor = true): Promise<void> {
    const response = await this._request('PUT', this._peerUrl, {
      body: this._announcement as Uint8Array<ArrayBuffer>,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (response.status === 409) {
      throw new Error(`HTTP signaling session ${JSON.stringify(this._sessionId)} rejected this participant (409 Conflict)`)
    }
    this._check(response)
    this._supportsJoinAnnouncements = response.headers.get('X-Magpie-Join-Announcements') === '1'
    if (resetCursor) this._cursor = 0 // relay may have restarted its sequence numbers
  }

  private _check(response: Response): void {
    if (!response.ok) throw new Error(`HTTP signaling ${response.status} ${response.statusText} at ${response.url}`)
  }

  private async _sleep(ms: number): Promise<void> {
    if (this._closed) return
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        this._stop.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this._stop.signal.addEventListener('abort', done, { once: true })
      if (this._closed) done()
    })
  }

  private async _sendLoop(): Promise<void> {
    this._sending = true
    try {
      while (!this._closed && this._outgoing.length) {
        const item = this._outgoing[0]
        let delay = 200
        while (!this._closed) {
          try {
            const response = await this._request('POST', this._messagesUrl, {
              body: item.payload as Uint8Array<ArrayBuffer>,
              headers: { 'Content-Type': 'application/octet-stream', 'X-Magpie-Message-Id': item.id },
            })
            if (this._closed) return
            if (response.status === 404) {
              await this._register()
              continue
            }
            this._check(response)
            this._outgoing.shift()
            break
          } catch (error) {
            if (this._closed) return
            Logger.warning(`HttpSignaler: send failed: ${error}`)
            await this._sleep(delay)
            delay = Math.min(delay * 2, 5000)
          }
        }
      }
    } finally {
      this._sending = false
      if (!this._closed && this._outgoing.length) void this._sendLoop()
    }
  }

  private async _pollLoop(): Promise<void> {
    this._polling = true
    let delay = 200
    try {
      while (!this._closed && this._callback) {
        try {
          const url = `${this._messagesUrl}?after=${this._cursor}&wait=${this._pollWait}`
          const response = await this._request('GET', url, {}, Math.max(this._requestTimeout, this._pollWait + 5))
          if (this._closed) return
          if (response.status === 404) {
            await this._register()
            continue
          }
          if (response.status === 204) { delay = 200; continue }
          this._check(response)
          const sequence = Number(response.headers.get('X-Magpie-Sequence'))
          if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Missing or invalid X-Magpie-Sequence')
          if (sequence <= this._cursor || !this._callback) continue
          const payload = new Uint8Array(await response.arrayBuffer())
          if (this._closed || !this._callback) continue
          try { this._callback(payload) } catch (error) {
            Logger.warning(`HttpSignaler: callback error: ${error}`)
          }
          this._cursor = sequence
          delay = 200
        } catch (error) {
          if (this._closed) return
          Logger.warning(`HttpSignaler: poll failed: ${error}`)
          await this._sleep(delay)
          delay = Math.min(delay * 2, 5000)
        }
      }
    } finally {
      this._polling = false
      if (!this._closed && this._callback) void this._pollLoop()
    }
  }
}
