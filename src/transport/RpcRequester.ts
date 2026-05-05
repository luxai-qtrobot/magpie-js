export interface RpcSchema {
  wrap(method: string, params?: Record<string, unknown>): Record<string, unknown>
  unwrap(response: unknown): unknown
}

export class AckTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'RPC ACK timeout')
    this.name = 'AckTimeoutError'
  }
}

export class ReplyTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'RPC reply timeout')
    this.name = 'ReplyTimeoutError'
  }
}

/**
 * Abstract RPC requester. Mirrors Python's RpcRequester base class.
 *
 * Without schema — raw object in/out:
 *   const client = new MqttRpcRequester(conn, 'myservice/actions')
 *   const res = await client.call({ action: 'run' }, 5.0)
 *
 * With schema — JSON-RPC 2.0 envelope handled automatically. Two call styles:
 *   const client = new MqttRpcRequester(conn, 'myservice/actions', { schema })
 *   const res = await client.call('add', { a: 3, b: 4 })
 *   const res = await client.call('add', { a: 3, b: 4 }, 5.0)  // with timeout
 *   const res = await (client as any).add({ a: 3, b: 4 })       // proxy style
 */
export abstract class RpcRequester {
  protected _schema: RpcSchema | null = null

  constructor(schema?: RpcSchema | null) {
    this._schema = schema ?? null
    if (schema != null) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this
      return new Proxy(this, {
        get(target, prop: string | symbol): unknown {
          if (typeof prop !== 'string') return (target as Record<string | symbol, unknown>)[prop]
          if (prop in target) return (target as Record<string, unknown>)[prop]
          if (self._schema == null) return undefined
          return (params?: Record<string, unknown>, timeout?: number) => self.call(prop, params, timeout)
        },
      }) as unknown as RpcRequester
    }
  }

  /** Transport-level call — implemented by each concrete transport. */
  protected abstract _transportCall(request: unknown, timeout?: number): Promise<unknown>

  /** Release resources. */
  abstract close(): void

  /**
   * Send an RPC call and return the response.
   *
   * Without schema:  call(rawPayload, timeout?)
   * With schema:     call(method, params?, timeout?)
   */
  async call(
    methodOrRequest: unknown,
    paramsOrTimeout?: Record<string, unknown> | number | null,
    timeout?: number,
  ): Promise<unknown> {
    if (this._schema != null && typeof methodOrRequest === 'string') {
      let params: Record<string, unknown> | undefined
      let t: number | undefined
      if (typeof paramsOrTimeout === 'number') {
        t = paramsOrTimeout
      } else if (paramsOrTimeout != null && typeof paramsOrTimeout === 'object') {
        params = paramsOrTimeout
        t = timeout
      } else {
        t = timeout
      }
      const envelope = this._schema.wrap(methodOrRequest, params)
      const response = await this._transportCall(envelope, t)
      return this._schema.unwrap(response)
    }
    const t = typeof paramsOrTimeout === 'number' ? paramsOrTimeout : timeout
    return this._transportCall(methodOrRequest, t)
  }
}
