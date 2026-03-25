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
 * Abstract RPC requester.
 * Mirrors Python's RpcRequester abstract base class.
 */
export abstract class RpcRequester {
  /**
   * Send a request and wait for the response.
   * @param request  Payload to send.
   * @param timeout  Max seconds to wait for the full reply.
   * @returns        Response payload.
   * @throws         AckTimeoutError | ReplyTimeoutError
   */
  abstract call(request: unknown, timeout?: number): Promise<unknown>

  /** Release resources. */
  abstract close(): void
}
