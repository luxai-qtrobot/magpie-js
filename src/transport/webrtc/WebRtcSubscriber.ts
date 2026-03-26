/**
 * WebRTC-based stream subscriber — implements StreamReader.
 *
 * Receives data published by the remote peer over the shared "magpie" data
 * channel, or receives incoming media tracks. The topic parameter controls
 * routing:
 *
 * - WebRtcSubscriber.VIDEO_TOPIC ("video"):
 *     read() resolves once with [MediaStreamTrack, "video"] when the remote
 *     video track arrives. Attach it to a <video> element:
 *       const [track] = await sub.read()
 *       videoEl.srcObject = new MediaStream([track as MediaStreamTrack])
 *
 * - WebRtcSubscriber.AUDIO_TOPIC ("audio"):
 *     read() resolves once with [MediaStreamTrack, "audio"].
 *
 * - Any other topic:
 *     Subscribes to that topic on the data channel; read() returns
 *     [deserialized_payload, topic] — same pattern as MqttSubscriber.
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot')
 *   await conn.connect(30)
 *
 *   // Data channel subscription
 *   const sub = new WebRtcSubscriber(conn, 'robot/state')
 *   const [data, topic] = await sub.read(5.0)
 *
 *   // Video track
 *   const vsub = new WebRtcSubscriber(conn, WebRtcSubscriber.VIDEO_TOPIC)
 *   const [track] = await vsub.read()
 *   videoEl.srcObject = new MediaStream([track as MediaStreamTrack])
 *
 *   sub.close()
 *   vsub.close()
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
  static readonly VIDEO_TOPIC = 'video'
  static readonly AUDIO_TOPIC = 'audio'

  private readonly _connection: WebRtcConnection
  private readonly _topic: string
  private readonly _queueSize: number
  private _queue: [unknown, string][] = []
  private _waiters: Waiter[] = []
  private _closed = false

  // Stable bound callbacks for later removal
  private readonly _boundPubCallback?: (payload: unknown, topic: string) => void
  private readonly _boundVideoCallback?: (track: MediaStreamTrack) => void
  private readonly _boundAudioCallback?: (track: MediaStreamTrack) => void

  constructor(connection: WebRtcConnection, topic: string, queueSize = 10) {
    super()
    this._connection = connection
    this._topic = topic
    this._queueSize = queueSize

    if (topic === WebRtcSubscriber.VIDEO_TOPIC) {
      this._boundVideoCallback = (track: MediaStreamTrack) =>
        this._enqueue([track, WebRtcSubscriber.VIDEO_TOPIC])
      connection.addVideoCallback(this._boundVideoCallback)
    } else if (topic === WebRtcSubscriber.AUDIO_TOPIC) {
      this._boundAudioCallback = (track: MediaStreamTrack) =>
        this._enqueue([track, WebRtcSubscriber.AUDIO_TOPIC])
      connection.addAudioCallback(this._boundAudioCallback)
    } else {
      this._boundPubCallback = (payload: unknown, t: string) =>
        this._enqueue([payload, t])
      connection.addPubCallback(topic, this._boundPubCallback)
    }

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

    if (this._topic === WebRtcSubscriber.VIDEO_TOPIC && this._boundVideoCallback) {
      this._connection.removeVideoCallback(this._boundVideoCallback)
    } else if (this._topic === WebRtcSubscriber.AUDIO_TOPIC && this._boundAudioCallback) {
      this._connection.removeAudioCallback(this._boundAudioCallback)
    } else if (this._boundPubCallback) {
      this._connection.removePubCallback(this._topic, this._boundPubCallback)
    }

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
