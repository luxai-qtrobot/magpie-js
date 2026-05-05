import { BaseSchema } from './BaseSchema'

// Standard JSON-RPC 2.0 error codes
export const PARSE_ERROR      = -32700
export const INVALID_REQUEST  = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS   = -32602
export const INTERNAL_ERROR   = -32603

export class JsonRpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
  }
}

export type MethodFunc = (params?: unknown) => unknown | Promise<unknown>

export interface MethodEntry {
  func: MethodFunc | null
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
}

export interface RegisterOptions {
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown> | null
}

export interface JsonSchemaToolEntry {
  name?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

// ------------------------------------------------------------------
// JsonRpcSchema
// ------------------------------------------------------------------

export class JsonRpcSchema extends BaseSchema {
  protected _methods = new Map<string, MethodEntry>()
  private _idCounter = 1

  // ----------------------------------------------------------------
  // Registration
  // ----------------------------------------------------------------

  register(name: string, func?: MethodFunc | null, options?: RegisterOptions): void {
    this._methods.set(name, {
      func: func ?? null,
      description: options?.description ?? '',
      inputSchema: options?.inputSchema ?? { type: 'object' },
      outputSchema: options?.outputSchema ?? null,
    })
  }

  /** Attach an implementation to an already-defined method (loaded via fromJSON / fromJsonString). */
  handler(name: string, func: MethodFunc): void {
    const entry = this._methods.get(name)
    if (!entry) {
      throw new Error(
        `'${name}' is not defined in this schema. Call register() or fromJSON() first.`,
      )
    }
    entry.func = func
  }

  // ----------------------------------------------------------------
  // Load from JSON
  // ----------------------------------------------------------------

  protected static _loadInto(schema: JsonRpcSchema, list: JsonSchemaToolEntry[]): void {
    for (const entry of list) {
      if (!entry.name) throw new Error(`Method entry missing 'name' field: ${JSON.stringify(entry)}`)
      schema.register(entry.name, null, {
        description: entry.description ?? '',
        inputSchema: entry.inputSchema ?? { type: 'object' },
        outputSchema: entry.outputSchema ?? null,
      })
    }
  }

  /** Load a schema from a parsed JS array of method objects. */
  static fromJSON(items: JsonSchemaToolEntry[]): JsonRpcSchema {
    const schema = new JsonRpcSchema()
    JsonRpcSchema._loadInto(schema, items)
    return schema
  }

  /**
   * Load a schema from a JSON string.
   * Expected format: [{ "name": "add", "description": "...", "inputSchema": {...} }]
   */
  static fromJsonString(s: string): JsonRpcSchema {
    const data = JSON.parse(s)
    if (!Array.isArray(data)) throw new TypeError('Expected a JSON array of method objects')
    return JsonRpcSchema.fromJSON(data as JsonSchemaToolEntry[])
  }

  // ----------------------------------------------------------------
  // Client helpers (requester side)
  // ----------------------------------------------------------------

  /** Build a JSON-RPC 2.0 request envelope. */
  wrap(method: string, params?: Record<string, unknown>): Record<string, unknown> {
    const req: Record<string, unknown> = { jsonrpc: '2.0', method, id: this._idCounter++ }
    if (params && Object.keys(params).length > 0) req.params = params
    return req
  }

  /**
   * Extract the result from a JSON-RPC 2.0 response.
   * @throws JsonRpcError if the response contains an error.
   */
  unwrap(response: unknown): unknown {
    if (typeof response !== 'object' || response === null) {
      throw new JsonRpcError(INVALID_REQUEST, `Invalid response: ${JSON.stringify(response)}`)
    }
    const r = response as Record<string, unknown>
    if ('error' in r) {
      const err = r.error as Record<string, unknown>
      throw new JsonRpcError(
        typeof err.code === 'number' ? err.code : INTERNAL_ERROR,
        typeof err.message === 'string' ? err.message : 'Unknown error',
      )
    }
    return r.result
  }

  // ----------------------------------------------------------------
  // Dispatch (responder side)
  // ----------------------------------------------------------------

  async dispatch(requestObj: unknown): Promise<unknown> {
    if (Array.isArray(requestObj)) {
      const responses = await Promise.all(requestObj.map(req => this._dispatchSingle(req)))
      const filtered = responses.filter(r => r !== null)
      return filtered.length > 0 ? filtered : null
    }
    return this._dispatchSingle(requestObj)
  }

  // ----------------------------------------------------------------
  // Private
  // ----------------------------------------------------------------

  private async _dispatchSingle(req: unknown): Promise<unknown> {
    if (typeof req !== 'object' || req === null) {
      return this._error(null, INVALID_REQUEST, 'Request must be an object')
    }

    const r = req as Record<string, unknown>
    const reqId = 'id' in r ? r.id : null
    const methodName = typeof r.method === 'string' ? r.method : null
    const params = r.params

    if (!methodName) return this._error(reqId, INVALID_REQUEST, "Missing 'method' field")

    const entry = this._methods.get(methodName)
    if (!entry) {
      if (reqId === null) return null   // unknown notification — silently ignore
      return this._error(reqId, METHOD_NOT_FOUND, `Method not found: ${methodName}`)
    }

    if (!entry.func) {
      if (reqId === null) return null
      return this._error(reqId, METHOD_NOT_FOUND, `Method not implemented: ${methodName}`)
    }

    try {
      let result: unknown
      if (params === undefined || params === null) {
        result = await Promise.resolve(entry.func())
      } else if (Array.isArray(params)) {
        result = await Promise.resolve((entry.func as (...a: unknown[]) => unknown)(...params))
      } else if (typeof params === 'object') {
        result = await Promise.resolve(entry.func(params as Record<string, unknown>))
      } else {
        return this._error(reqId, INVALID_PARAMS, "'params' must be object or array")
      }

      if (reqId === null) return null   // notification — no reply
      return this._result(reqId, result)
    } catch (e) {
      if (reqId === null) return null
      return this._error(reqId, INTERNAL_ERROR, (e as Error).message ?? String(e))
    }
  }

  private _error(id: unknown, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', error: { code, message }, id }
  }

  private _result(id: unknown, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', result, id }
  }
}
