export type RequestHandler = (request: unknown) => unknown | Promise<unknown>

/**
 * Abstract RPC responder.
 * Mirrors Python's RpcResponder abstract base class.
 */
export abstract class RpcResponder {
  /**
   * Register a handler that is called for every incoming request.
   * The handler's return value is sent back as the response.
   * The handler may be sync or async.
   */
  abstract onRequest(handler: RequestHandler): void

  /** Release resources. */
  abstract close(): void
}
