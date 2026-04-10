/**
 * WebRTC-based RPC requester — implements RpcRequester.
 *
 * Sends RPC requests over the "magpie" data channel and waits for an ACK
 * then a final reply. Because the data channel is a bidirectional P2P pipe,
 * no reply_to topic is needed — both request and reply travel on the same
 * channel, demuxed by rid.
 *
 * Wire protocol (identical to Python WebRTCRpcRequester):
 *   Requester → channel: { type:"rpc_req", service:"...", rid:"<ulid>", payload:<req> }
 *   Responder → channel: { type:"rpc_ack", rid:"<ulid>" }
 *   Responder → channel: { type:"rpc_rep", rid:"<ulid>", payload:<res> }
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot')
 *   await conn.connect(30)
 *
 *   const client = new WebRtcRpcRequester(conn, 'robot/motion')
 *   try {
 *     const res = await client.call({ action: 'move', x: 1.0 }, 5.0)
 *   } catch (err) {
 *     if (err instanceof AckTimeoutError) { ... }
 *     if (err instanceof ReplyTimeoutError) { ... }
 *   } finally {
 *     client.close()
 *   }
 */

import { RpcRequester, AckTimeoutError, ReplyTimeoutError } from '../RpcRequester'
import { Logger } from '../../utils/logger'
import { getUniqueId } from '../../utils/common'
import { WebRtcConnection } from './WebRtcConnection'

interface PendingCall {
  ackTimer: ReturnType<typeof setTimeout> | null
  replyTimer: ReturnType<typeof setTimeout> | null
  resolveReply: (payload: unknown) => void
  rejectReply: (err: Error) => void
}


export class WebRtcRpcRequester extends RpcRequester {
  private readonly _connection: WebRtcConnection
  private readonly _serviceName: string
  private readonly _ackTimeout: number
  private _pending = new Map<string, PendingCall>()

  constructor(
    connection: WebRtcConnection,
    serviceName: string,
    options?: { ackTimeout?: number },
  ) {
    super()
    this._connection = connection
    this._serviceName = serviceName.replace(/^\//, '')
    this._ackTimeout = options?.ackTimeout ?? 2.0
    Logger.debug(`WebRtcRpcRequester: ready for service '${this._serviceName}'.`)
  }

  async call(request: unknown, timeout?: number): Promise<unknown> {
    const rid = getUniqueId()

    return new Promise<unknown>((resolve, reject) => {
      const ackDeadline = timeout !== undefined ? Math.min(timeout, this._ackTimeout) : this._ackTimeout

      const pending: PendingCall = {
        ackTimer: null,
        replyTimer: null,
        resolveReply: resolve,
        rejectReply: reject,
      }

      const cleanup = () => {
        if (pending.ackTimer) { clearTimeout(pending.ackTimer); pending.ackTimer = null }
        if (pending.replyTimer) { clearTimeout(pending.replyTimer); pending.replyTimer = null }
        this._pending.delete(rid)
        this._connection.unregisterRpcReply(rid)
      }

      // Register reply callback before sending to avoid missing a fast reply
      this._connection.registerRpcReply(rid, (msg: unknown) => {
        const m = msg as Record<string, unknown>
        const type = m['type'] as string

        if (type === 'rpc_ack') {
          // ACK received — cancel ack timer, arm reply timer
          if (pending.ackTimer) { clearTimeout(pending.ackTimer); pending.ackTimer = null }
          if (timeout !== undefined) {
            pending.replyTimer = setTimeout(() => {
              cleanup()
              reject(new ReplyTimeoutError(
                `WebRtcRpcRequester: no reply from '${this._serviceName}' within ${timeout}s`,
              ))
            }, timeout * 1000)
          }

        } else if (type === 'rpc_rep') {
          cleanup()
          if ('payload' in m) {
            resolve(m['payload'])
          } else {
            reject(new Error(`WebRtcRpcRequester: malformed reply for rid='${rid}': ${JSON.stringify(m)}`))
          }
        }
      })

      this._pending.set(rid, pending)

      // Send the request
      this._connection.sendData({
        type: 'rpc_req',
        service: this._serviceName,
        rid,
        payload: request,
      })

      // ACK timer
      pending.ackTimer = setTimeout(() => {
        cleanup()
        reject(new AckTimeoutError(
          `WebRtcRpcRequester: no ACK from '${this._serviceName}' within ${ackDeadline}s`,
        ))
      }, ackDeadline * 1000)
    })
  }

  close(): void {
    // Fail all in-flight calls
    for (const [rid, pending] of this._pending) {
      if (pending.ackTimer) clearTimeout(pending.ackTimer)
      if (pending.replyTimer) clearTimeout(pending.replyTimer)
      this._connection.unregisterRpcReply(rid)
      pending.rejectReply(new Error('WebRtcRpcRequester: closed'))
    }
    this._pending.clear()
    Logger.debug('WebRtcRpcRequester: closed.')
  }
}
