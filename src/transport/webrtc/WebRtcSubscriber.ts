/**
 * WebRTC-based stream subscriber — implements StreamReader.
 *
 * Receives data published by the remote peer over the shared "magpie" data
 * channel (and the "magpie-media" fallback channel when useMediaChannels=true).
 * All topic routing is topic-string-keyed; there are no reserved sentinel topics.
 *
 * For receiving native RTP video/audio tracks use the connection API directly:
 *   const track = await conn.receiveVideoTrack('/camera/color/image')
 *   videoEl.srcObject = new MediaStream([track])
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot',
 *     { webrtcOptions: { videoTopics: ['/camera/color/image'] } })
 *   await conn.connect(30)
 *
 *   // Data subscription (any non-media topic)
 *   const sub = new WebRtcSubscriber(conn, 'robot/state')
 *   const [data, topic] = await sub.read(5.0)
 *   sub.close()
 *
 *   // RTP video track
 *   const track = await conn.receiveVideoTrack('/camera/color/image')
 *   videoEl.srcObject = new MediaStream([track])
 */

import { StreamReader } from '../StreamReader'
import { Logger } from '../../utils/logger'
import { WebRtcConnection } from './WebRtcConnection'

interface Waiter {
  resolve: (value: [unknown, string]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

class TimeoutError extends Error {
  constructor(msg?: string) { super(msg ?? 'read timeout'); this.name = 'TimeoutError' }
}


export class WebRtcSubscriber extends StreamReader {
  private readonly _connection: WebRtcConnection
  private readonly _topic: string
  private readonly _queueSize: number
  private _queue: [unknown, string][] = []
  private _waiters: Waiter[] = []
  private _closed = false

  private readonly _boundPubCallback: (payload: unknown, topic: string) => void

  constructor(connection: WebRtcConnection, topic: string, queueSize = 10) {
    super()
    this._connection = connection
    this._topic = topic
    this._queueSize = queueSize

    // All subscriptions go through the data channel pub-callback path.
    // Video/audio frames arriving on the magpie-media fallback channel are
    // also routed to pub callbacks by topic (see WebRtcConnection._routeMediaMessage),
    // so this subscriber handles both data and media-fallback frames transparently.
    this._boundPubCallback = (payload: unknown, t: string) =>
      this._enqueue([payload, t])
    connection.addPubCallback(topic, this._boundPubCallback)

    Logger.debug(`WebRtcSubscriber: subscribed to '${topic}'.`)
  }

  async read(timeout?: number): Promise<[unknown, string]> {
    if (this._closed) throw new Error('WebRtcSubscriber: already closed')

    if (this._queue.length > 0) return this._queue.shift()!

    return new Promise<[unknown, string]>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null }

      if (timeout !== undefined) {
        waiter.timer = setTimeout(() => {
          this._waiters = this._waiters.filter(w => w !== waiter)
          reject(new TimeoutError(`WebRtcSubscriber: read timeout after ${timeout}s`))
        }, timeout * 1000)
      }

      this._waiters.push(waiter)
    })
  }

  close(): void {
    this._closed = true
    this._connection.removePubCallback(this._topic, this._boundPubCallback)

    for (const waiter of this._waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(new Error('WebRtcSubscriber: closed'))
    }
    this._waiters = []

    Logger.debug(`WebRtcSubscriber: closed ('${this._topic}').`)
  }

  // ---- Internal -----------------------------------------------------------

  private _enqueue(item: [unknown, string]): void {
    if (this._closed) return

    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(item)
      return
    }

    // Buffer — drop oldest if full (latest-value semantics for data topics)
    if (this._queue.length >= this._queueSize) this._queue.shift()
    this._queue.push(item)
  }
}
