import { RpcRequester } from '../../transport/RpcRequester'
import { Logger } from '../../utils/logger'

/**
 * MCP Transport backed by any MAGPIE RpcRequester.
 *
 * Implements the Transport interface from @modelcontextprotocol/sdk
 * (structurally compatible — no direct dependency required on the server side).
 *
 * Usage with @modelcontextprotocol/sdk Client:
 *
 *   import { Client } from '@modelcontextprotocol/sdk/client/index.js'
 *   import { McpTransport } from '@luxai-qtrobot/magpie'
 *
 *   const req = new MqttRpcRequester(conn, 'node-01')
 *   const transport = new McpTransport(req)
 *   const client = new Client({ name: 'my-agent', version: '1.0' })
 *   await client.connect(transport)
 *
 *   const tools = await client.listTools()
 *   const result = await client.callTool({ name: 'translate', arguments: { text: 'Hello', target_lang: 'fr' } })
 *
 *   await client.close()
 *   req.close()
 *
 * Protocol flow:
 *   MCP Client ──JSON-RPC──► McpTransport (bridge)
 *                                  │  MAGPIE request/reply
 *                                  ▼
 *                           RpcResponder + McpSchema (service)
 *
 * The caller creates and owns the requester (and its connection).
 * McpTransport borrows it and never closes it on session end.
 */
export class McpTransport {
  onmessage?: (message: Record<string, unknown>) => void
  onerror?: (error: Error) => void
  onclose?: () => void

  private _requester: RpcRequester
  private _timeout: number

  constructor(requester: RpcRequester, timeout = 30) {
    this._requester = requester
    this._timeout = timeout
  }

  async start(): Promise<void> {
    // Nothing to set up — the requester is already connected
    Logger.debug(`McpTransport: started via ${this._requester.constructor.name}`)
  }

  /**
   * Send a JSON-RPC message to the MAGPIE service.
   * Notifications (no id) are dropped — MAGPIE always expects a reply.
   * Requests are forwarded via requester.call() and the response is
   * delivered asynchronously via onmessage.
   */
  async send(message: Record<string, unknown>): Promise<void> {
    if (!('id' in message)) return  // notification — drop

    this._requester
      .call(message, this._timeout)
      .then(response => {
        if (response != null && this.onmessage) {
          this.onmessage(response as Record<string, unknown>)
        }
      })
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err))
        Logger.debug(`McpTransport: call error: ${error.message}`)
        if (this.onerror) this.onerror(error)
      })
  }

  async close(): Promise<void> {
    Logger.debug('McpTransport: closed.')
    this.onclose?.()
  }
}
