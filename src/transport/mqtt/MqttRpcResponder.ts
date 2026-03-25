import { RpcResponder, RequestHandler } from '../RpcResponder'
import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { BaseSerializer } from '../../serializer/BaseSerializer'
import { Logger } from '../../utils/logger'
import { MqttConnection } from './MqttConnection'

/**
 * MQTT-based RPC responder — implements RpcResponder.
 *
 * Protocol (matches Python MqttRpcResponder exactly):
 *   1. Listen on <service>/rpc/req
 *   2. On request: send ACK to reply_to topic: { rid, ack: true }
 *   3. Call handler, send response to reply_to: { rid, payload: <result> }
 *
 * Usage:
 *   const conn = new MqttConnection('mqtt://broker.example.com:1883')
 *   await conn.connect()
 *   const responder = new MqttRpcResponder(conn, 'myrobot/motion')
 *   responder.onRequest(async (req) => ({ status: 'ok', echo: req }))
 */
export class MqttRpcResponder extends RpcResponder {
  private _connection: MqttConnection
  private _serializer: BaseSerializer
  private _reqTopic: string
  private _qos?: 0 | 1 | 2
  private _handler: RequestHandler | null = null

  constructor(
    connection: MqttConnection,
    serviceName: string,
    options?: {
      serializer?: BaseSerializer
      qos?: 0 | 1 | 2
    }
  ) {
    super()
    this._connection = connection
    this._serializer = options?.serializer ?? new MsgpackSerializer()
    this._qos = options?.qos

    const svc = serviceName.replace(/^\//, '')
    this._reqTopic = `${svc}/rpc/req`

    connection.addSubscription(this._reqTopic, this._onRequest.bind(this), this._qos)
    Logger.debug(`MqttRpcResponder: listening on '${this._reqTopic}'`)
  }

  onRequest(handler: RequestHandler): void {
    this._handler = handler
  }

  close(): void {
    this._connection.removeSubscription(this._reqTopic, this._onRequest.bind(this))
    this._handler = null
    Logger.debug('MqttRpcResponder: closed.')
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private async _onRequest(payloadBytes: Uint8Array, _topic: string): Promise<void> {
    let msg: Record<string, unknown>
    try {
      msg = this._serializer.deserialize(payloadBytes) as Record<string, unknown>
    } catch (e) {
      Logger.warning(`MqttRpcResponder: failed to deserialize request: ${e}`)
      return
    }

    const rid = typeof msg['rid'] === 'string' ? msg['rid'] : null
    const replyTo = typeof msg['reply_to'] === 'string' ? msg['reply_to'] : null

    if (!rid || !replyTo) {
      Logger.warning(`MqttRpcResponder: malformed request (missing rid or reply_to)`)
      return
    }

    // Send ACK immediately
    try {
      const ack = this._serializer.serialize({ rid, ack: true })
      await this._connection.publish(replyTo, ack, this._qos ?? 1)
    } catch (e) {
      Logger.warning(`MqttRpcResponder: failed to send ACK for rid='${rid}': ${e}`)
      return
    }

    if (!this._handler) {
      Logger.warning(`MqttRpcResponder: no handler registered, dropping request rid='${rid}'`)
      return
    }

    // Call handler and send response
    try {
      const result = await Promise.resolve(this._handler(msg['payload']))
      const reply = this._serializer.serialize({ rid, payload: result })
      await this._connection.publish(replyTo, reply, this._qos ?? 1)
    } catch (e) {
      Logger.warning(`MqttRpcResponder: handler error for rid='${rid}': ${e}`)
    }
  }
}
