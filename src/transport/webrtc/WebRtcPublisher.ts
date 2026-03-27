/**
 * WebRTC-based stream publisher — implements StreamWriter.
 *
 * Writes serializable data to the remote peer over the shared "magpie" data
 * channel. The data channel envelope matches Python exactly:
 *   { type: "pub", topic: "<topic>", payload: <data> }
 *
 * For sending local video or audio to the remote peer via RTP (useMediaChannels=true),
 * add your MediaStreamTrack to the connection before connect():
 *   conn.setLocalVideoTrack(track)   // from getUserMedia() or canvas.captureStream()
 *   conn.setLocalAudioTrack(track)
 *
 * VIDEO_TOPIC / AUDIO_TOPIC are reserved sentinels — do not use them as topics
 * for non-media data (a warning is logged and the message is dropped).
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot')
 *   await conn.connect(30)
 *
 *   const pub = new WebRtcPublisher(conn)
 *   await pub.write({ motor: [0.1, 0.2] }, 'robot/cmd')
 *   pub.close()
 *   await conn.disconnect()
 */

import { StreamWriter } from '../StreamWriter'
import { Logger } from '../../utils/logger'
import { WebRtcConnection } from './WebRtcConnection'


export class WebRtcPublisher extends StreamWriter {
  static readonly VIDEO_TOPIC = 'video'
  static readonly AUDIO_TOPIC = 'audio'

  private readonly _connection: WebRtcConnection

  constructor(connection: WebRtcConnection) {
    super()
    this._connection = connection
    Logger.debug('WebRtcPublisher: ready.')
  }

  async write(data: unknown, topic: string): Promise<void> {
    if (!topic) {
      Logger.warning('WebRtcPublisher: write() called without a topic — message dropped.')
      return
    }

    // Guard: VIDEO_TOPIC/AUDIO_TOPIC are reserved for media tracks (useMediaChannels=true).
    // Sending non-media data on these topics would confuse the subscriber routing.
    if (
      this._connection.useMediaChannels &&
      (topic === WebRtcPublisher.VIDEO_TOPIC || topic === WebRtcPublisher.AUDIO_TOPIC)
    ) {
      Logger.warning(
        `WebRtcPublisher: topic '${topic}' is reserved for media tracks — ` +
        `set a local media track via conn.setLocalVideoTrack() before connect(). Message dropped.`,
      )
      return
    }

    this._connection.sendData({ type: 'pub', topic, payload: data })
  }

  close(): void {
    // Connection is shared; closing the publisher does NOT disconnect.
    Logger.debug('WebRtcPublisher: closed.')
  }
}
