/**
 * WebRTC-based RPC responder — implements RpcResponder.
 *
 * Listens for RPC requests from the remote peer on the "magpie" data channel,
 * sends an immediate ACK, invokes the user-supplied handler, and replies —
 * all over the same bidirectional data channel.
 *
 * Wire protocol (identical to Python WebRTCRpcResponder):
 *   Requester → channel: { type:"rpc_req", service:"...", rid:"<ulid>", payload:<req> }
 *   Responder → channel: { type:"rpc_ack", rid:"<ulid>" }
 *   Responder → channel: { type:"rpc_rep", rid:"<ulid>", payload:<res> }
 *
 * Usage:
 *   const conn = await WebRtcConnection.withMqtt('wss://broker:8884/mqtt', 'my-robot')
 *   await conn.connect(30)
 *
 *   const responder = new WebRtcRpcResponder(conn, 'robot/motion')
 *   responder.onRequest(async (req) => {
 *     console.log('Request:', req)
 *     return { status: 'ok', echo: req }
 *   })
 *
 *   // Later:
 *   responder.close()
 *   await conn.disconnect()
 */

import { RpcResponder, RequestHandler } from '../RpcResponder'
import { Logger } from '../../utils/logger'
import { WebRtcConnection } from './WebRtcConnection'


export class WebRtcRpcResponder extends RpcResponder {
  private readonly _connection: WebRtcConnection
  private readonly _serviceName: string
  private _handler: RequestHandler | null = null
  private readonly _boundCallback: (msg: unknown) => void

  constructor(connection: WebRtcConnection, serviceName: string) {
    super()
    this._connection = connection
    this._serviceName = serviceName.replace(/^\//, '')
    this._boundCallback = this._onRequest.bind(this)
    connection.addRpcService(this._serviceName, this._boundCallback)
    Logger.debug(`WebRtcRpcResponder: listening on service '${this._serviceName}'.`)
  }

  onRequest(handler: RequestHandler): void {
    this._handler = handler
  }

  close(): void {
    this._connection.removeRpcService(this._serviceName)
    this._handler = null
    Logger.debug('WebRtcRpcResponder: closed.')
  }

  // ---- Internal -----------------------------------------------------------

  private async _onRequest(msg: unknown): Promise<void> {
    const m = msg as Record<string, unknown>
    const rid = m['rid'] as string | undefined

    if (!rid) {
      Logger.warning('WebRtcRpcResponder: received request without rid.')
      return
    }

    // Send ACK immediately before invoking the handler
    this._connection.sendData({ type: 'rpc_ack', rid })

    if (!this._handler) {
      Logger.warning(
        `WebRtcRpcResponder: no handler registered — dropping request rid='${rid}'`,
      )
      return
    }

    try {
      const result = await Promise.resolve(this._handler(m['payload']))
      this._connection.sendData({ type: 'rpc_rep', rid, payload: result })
    } catch (e) {
      Logger.warning(`WebRtcRpcResponder: handler error for rid='${rid}': ${e}`)
    }
  }
}
