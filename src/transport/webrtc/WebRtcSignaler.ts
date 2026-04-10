/**
 * WebRTC signaling transport abstraction.
 *
 * WebRtcSignaler defines the minimal interface a signaling transport must
 * implement: publish and subscribe raw bytes on a session-specific channel.
 *
 * Built-in implementation:
 * - MqttSignaler — MQTT broker; uses the existing MqttConnection.
 *
 * Mirrors Python's WebRtcSignaler ABC + MqttSignaler.
 */

import { MqttConnection } from '../mqtt/MqttConnection'
import { MqttOptions } from '../mqtt/MqttOptions'
import { Logger } from '../../utils/logger'


// ---------------------------------------------------------------------------
// Abstract base
// ---------------------------------------------------------------------------

export abstract class WebRtcSignaler {
  /**
   * Shared session name used by both peers to find each other.
   * Derived from the session_id provided at construction.
   */
  abstract get sessionId(): string

  /** Publish a raw signaling message to the shared channel. */
  abstract publish(payload: Uint8Array): void

  /**
   * Register callback to be called with raw bytes whenever a signaling
   * message arrives. Only one callback is supported at a time.
   */
  abstract subscribe(callback: (payload: Uint8Array) => void): void

  /** Remove the previously registered callback. */
  abstract unsubscribe(): void

  /** Shut down the signaling transport and release resources. */
  abstract disconnect(): Promise<void>
}


// ---------------------------------------------------------------------------
// MqttSignaler
// ---------------------------------------------------------------------------

/**
 * MQTT-backed signaling transport.
 *
 * Both WebRTC peers subscribe and publish to the same MQTT topic:
 *   magpie/webrtc/<sessionId>/signal
 *
 * Use MqttSignaler.create() to asynchronously connect to the broker and
 * construct the signaler in one step, or construct it manually from an
 * already-connected MqttConnection.
 *
 * Example (browser):
 *   const conn = await WebRtcConnection.withMqtt(
 *     'wss://broker.hivemq.com:8884/mqtt',
 *     'my-robot'
 *   )
 *   await conn.connect()
 */
export class MqttSignaler extends WebRtcSignaler {
  private readonly _conn: MqttConnection
  private readonly _sessionId: string
  private readonly _topic: string
  private _callback: ((payload: Uint8Array) => void) | null = null
  // Bound once so addSubscription / removeSubscription use the same reference.
  private readonly _boundHandler: (payload: Uint8Array, topic: string) => void

  /**
   * Construct from an already-connected MqttConnection.
   * Prefer MqttSignaler.create() for a one-step async constructor.
   */
  constructor(conn: MqttConnection, sessionId: string) {
    super()
    this._conn = conn
    this._sessionId = sessionId
    this._topic = `magpie/webrtc/${sessionId}/signal`
    this._boundHandler = this._onMqttMessage.bind(this)
    Logger.debug(`MqttSignaler: topic='${this._topic}'`)
  }

  /**
   * Asynchronously connect to the MQTT broker and return a ready MqttSignaler.
   *
   * @param brokerUrl  MQTT broker URI. Use wss:// in the browser.
   * @param sessionId  Shared rendezvous name — must match the remote peer.
   * @param options    MQTT auth/session/reconnect options + optional clientId
   *                   and timeout (seconds, default 10).
   */
  static async create(
    brokerUrl: string,
    sessionId: string,
    options?: MqttOptions & { clientId?: string; timeout?: number },
  ): Promise<MqttSignaler> {
    // Disable auto-reconnect on the signaling connection — after WebRTC is
    // established the data channel takes over; persistent MQTT reconnect loops
    // only create noise and break the SDK's disconnect logic.
    const conn = new MqttConnection(brokerUrl, { ...options, reconnect: { minDelaySec: 0 } })
    await conn.connect((options?.timeout ?? 10) * 1000)
    return new MqttSignaler(conn, sessionId)
  }

  // ---- WebRtcSignaler interface --------------------------------------------

  get sessionId(): string { return this._sessionId }

  publish(payload: Uint8Array): void {
    this._conn.publish(this._topic, payload).catch(e =>
      Logger.warning(`MqttSignaler: publish error: ${e}`)
    )
  }

  subscribe(callback: (payload: Uint8Array) => void): void {
    this._callback = callback
    this._conn.addSubscription(this._topic, this._boundHandler)
  }

  unsubscribe(): void {
    this._conn.removeSubscription(this._topic, this._boundHandler)
    this._callback = null
  }

  async disconnect(): Promise<void> {
    await this._conn.disconnect()
  }

  // ---- Internal -----------------------------------------------------------

  private _onMqttMessage(payload: Uint8Array, _topic: string): void {
    this._callback?.(payload)
  }
}
