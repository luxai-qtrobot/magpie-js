import { RpcRequester, AckTimeoutError, ReplyTimeoutError } from '../RpcRequester'
import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { BaseSerializer } from '../../serializer/BaseSerializer'
import { Logger } from '../../utils/logger'
import { getUniqueId } from '../../utils/common'
import { MqttConnection } from './MqttConnection'

interface PendingCall {
  onAck: () => void
  onReply: (payload: unknown) => void
  onError: (err: Error) => void
}

/**
 * MQTT-based RPC requester — implements RpcRequester.
 *
 * Protocol (matches Python MqttRpcRequester exactly):
 *   1. Publish to  <service>/rpc/req:
 *      { rid: "<ulid>", reply_to: "<reply_topic>", payload: <request> }
 *   2. Receive ACK on <reply_topic>:
 *      { rid: "<ulid>", ack: true }
 *   3. Receive reply on <reply_topic>:
 *      { rid: "<ulid>", payload: <response> }
 *
 * Reply topic: magpie/rpc/<clientId>/<instanceId>/rep
 */
export class MqttRpcRequester extends RpcRequester {
  private _connection: MqttConnection
  private _serializer: BaseSerializer
  private _reqTopic: string
  private _repTopic: string
  private _ackTimeout: number
  private _qos?: 0 | 1 | 2
  private _pending = new Map<string, PendingCall>()

  constructor(
    connection: MqttConnection,
    serviceName: string,
    options?: {
      serializer?: BaseSerializer
      ackTimeout?: number
      qos?: 0 | 1 | 2
      name?: string
    }
  ) {
    super()
    this._connection = connection
    this._serializer = options?.serializer ?? new MsgpackSerializer()
    this._ackTimeout = options?.ackTimeout ?? 2.0
    this._qos = options?.qos

    const svc = serviceName.replace(/^\//, '')
    this._reqTopic = `${svc}/rpc/req`

    const instanceId = getUniqueId().slice(0, 12)
    this._repTopic = `magpie/rpc/${connection.clientId}/${instanceId}/rep`

    connection.addSubscription(this._repTopic, this._onReply.bind(this), this._qos)

    Logger.debug(`MqttRpcRequester: req='${this._reqTopic}', rep='${this._repTopic}'`)
  }

  async call(request: unknown, timeout?: number): Promise<unknown> {
    const rid = getUniqueId()

    return new Promise<unknown>((resolve, reject) => {
      let ackTimer: ReturnType<typeof setTimeout> | null = null
      let replyTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (ackTimer) clearTimeout(ackTimer)
        if (replyTimer) clearTimeout(replyTimer)
        this._pending.delete(rid)
      }

      const ackDeadline = timeout !== undefined ? Math.min(timeout, this._ackTimeout) : this._ackTimeout

      ackTimer = setTimeout(() => {
        cleanup()
        reject(new AckTimeoutError(
          `MqttRpcRequester: no ACK from '${this._reqTopic}' within ${ackDeadline}s`
        ))
      }, ackDeadline * 1000)

      this._pending.set(rid, {
        onAck: () => {
          if (ackTimer) clearTimeout(ackTimer)
          if (timeout !== undefined) {
            replyTimer = setTimeout(() => {
              cleanup()
              reject(new ReplyTimeoutError(
                `MqttRpcRequester: no reply from '${this._reqTopic}' within ${timeout}s`
              ))
            }, timeout * 1000)
          }
        },
        onReply: (payload: unknown) => {
          cleanup()
          resolve(payload)
        },
        onError: (err: Error) => {
          cleanup()
          reject(err)
        },
      })

      // Publish after registering to avoid missing a very fast reply
      const req = { rid, reply_to: this._repTopic, payload: request }
      const bytes = this._serializer.serialize(req)
      this._connection.publish(this._reqTopic, bytes, this._qos ?? 1).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  close(): void {
    this._connection.removeSubscription(this._repTopic, this._onReply.bind(this))
    for (const [, pending] of this._pending) {
      pending.onError(new Error('MqttRpcRequester: closed'))
    }
    this._pending.clear()
    Logger.debug('MqttRpcRequester: closed.')
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private _onReply(payloadBytes: Uint8Array, _topic: string): void {
    let msg: Record<string, unknown>
    try {
      msg = this._serializer.deserialize(payloadBytes) as Record<string, unknown>
    } catch (e) {
      Logger.warning(`MqttRpcRequester: failed to deserialize reply: ${e}`)
      return
    }

    const rid = typeof msg['rid'] === 'string' ? msg['rid'] : null
    if (!rid) {
      Logger.warning(`MqttRpcRequester: reply without 'rid': ${JSON.stringify(msg)}`)
      return
    }

    const pending = this._pending.get(rid)
    if (!pending) {
      Logger.debug(`MqttRpcRequester: late or unknown rid='${rid}'`)
      return
    }

    if (msg['ack'] === true) {
      pending.onAck()
    } else if ('payload' in msg) {
      pending.onReply(msg['payload'])
    } else {
      pending.onError(new Error(`MqttRpcRequester: unexpected reply format: ${JSON.stringify(msg)}`))
    }
  }
}
