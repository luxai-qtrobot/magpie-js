/**
 * Abstract stream reader (subscriber).
 * Mirrors Python's StreamReader abstract base class.
 */
export abstract class StreamReader {
  /**
   * Wait for the next message.
   * @param timeout  Max seconds to wait. Rejects with TimeoutError if exceeded.
   * @returns        Tuple of [data, topic].
   */
  abstract read(timeout?: number): Promise<[unknown, string]>

  /** Release resources associated with this reader. */
  abstract close(): void
}
