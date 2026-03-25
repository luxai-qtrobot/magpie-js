/**
 * Abstract stream writer (publisher).
 * Mirrors Python's StreamWriter abstract base class.
 */
export abstract class StreamWriter {
  /**
   * Publish `data` to `topic`.
   * Implementations should serialize and deliver the message.
   */
  abstract write(data: unknown, topic: string): Promise<void>

  /** Release resources associated with this writer. */
  abstract close(): void
}
