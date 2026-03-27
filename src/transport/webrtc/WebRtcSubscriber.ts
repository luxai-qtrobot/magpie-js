/**
 * WebRTC-based stream subscriber — implements StreamReader.
 *
 * Receives data published by the remote peer over the shared "magpie" data
 * channel, or receives incoming media tracks. Routing depends on the topic and
 * the connection's useMediaChannels setting:
 *
 * useMediaChannels=true (default):
 * - VIDEO_TOPIC ("video"): read() resolves with [MediaStreamTrack, "video"] when
 *     the remote RTP video track arrives. Attach to a <video> element:
 *       const [track] = await sub.read()
 *       videoEl.srcObject = new MediaStream([track as MediaStreamTrack])
 * - AUDIO_TOPIC ("audio"): read() resolves with [MediaStreamTrack, "audio"].
 * - Any other topic: subscribes to that topic on the data channel.
 *
 * useMediaChannels=false:
 * - VIDEO_TOPIC / AUDIO_TOPIC / any topic: all routed via the data channel.
 *     read() returns [frame-dict, topic] — full topic routing, multiple
 *     video/audio topics supported.
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot')
 *   await conn.connect(30)
 *
 *   // Data channel subscription
 *   const sub = new WebRtcSubscriber(conn, 'robot/state')
 *   const [data, topic] = await sub.read(5.0)
 *
 *   // RTP video track (useMediaChannels=true, default)
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
  private readonly _boundVideoCallback?: (data: MediaStreamTrack | Record<string, unknown>) => void
  private readonly _boundAudioCallback?: (data: MediaStreamTrack | Record<string, unknown>) => void

  constructor(connection: WebRtcConnection, topic: string, queueSize = 10) {
    super()
    this._connection = connection
    this._topic = topic
    this._queueSize = queueSize

    const useMedia = connection.useMediaChannels

    if (useMedia && topic === WebRtcSubscriber.VIDEO_TOPIC) {
      // useMediaChannels=true + VIDEO_TOPIC → receive RTP track from remote peer
      this._boundVideoCallback = (data: MediaStreamTrack | Record<string, unknown>) =>
        this._enqueue([data, WebRtcSubscriber.VIDEO_TOPIC])
      connection.addVideoCallback(this._boundVideoCallback)
    } else if (useMedia && topic === WebRtcSubscriber.AUDIO_TOPIC) {
      // useMediaChannels=true + AUDIO_TOPIC → receive RTP track from remote peer
      this._boundAudioCallback = (data: MediaStreamTrack | Record<string, unknown>) =>
        this._enqueue([data, WebRtcSubscriber.AUDIO_TOPIC])
      connection.addAudioCallback(this._boundAudioCallback)
    } else {
      // useMediaChannels=false: VIDEO_TOPIC/AUDIO_TOPIC are real topic names on data channel.
      // Any other topic: normal data channel subscription.
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

    const useMedia = this._connection.useMediaChannels
    if (useMedia && this._topic === WebRtcSubscriber.VIDEO_TOPIC && this._boundVideoCallback) {
      this._connection.removeVideoCallback(this._boundVideoCallback)
    } else if (useMedia && this._topic === WebRtcSubscriber.AUDIO_TOPIC && this._boundAudioCallback) {
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
