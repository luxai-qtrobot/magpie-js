/**
 * WebRTC-based stream publisher — implements StreamWriter.
 *
 * Writes serializable data to the remote peer over the shared "magpie" data
 * channel. The data channel envelope matches Python exactly:
 *   { type: "pub", topic: "<topic>", payload: <data> }
 *
 * This publisher handles data-channel messages only. For sending local
 * video or audio to the remote peer via native RTP tracks, register
 * the track on the connection before connect():
 *   conn.sendVideoTrack(track, '/camera/color/image')
 *   conn.sendAudioTrack(track, '/mic/audio/stream')
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
    this._connection.sendData({ type: 'pub', topic, payload: data })
  }

  close(): void {
    // Connection is shared; closing the publisher does NOT disconnect.
    Logger.debug('WebRtcPublisher: closed.')
  }
}
