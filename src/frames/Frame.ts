import { getUniqueId, getUtcTimestamp } from '../utils/common'

export type FrameDict = Record<string, unknown>

// Module-level registry — mirrors Python's Frame._registry class variable
const _registry = new Map<string, (data: FrameDict) => Frame>()

/**
 * Base frame class — mirrors Python's Frame dataclass.
 *
 * Wire format (msgpack dict):
 *   { gid, id, name, timestamp, ...subclass fields }
 *
 * Rules that match Python exactly:
 *  - gid:       preserved from wire data if provided, otherwise a fresh ULID
 *  - id:        preserved from wire data if provided, otherwise 0
 *  - name:      always the constructor name (class name) — never from wire
 *  - timestamp: always the current UTC time — never from wire
 *    (matches Python's __post_init__ which unconditionally sets timestamp)
 */
export class Frame {
  gid: string
  id: number
  readonly name: string
  readonly timestamp: string

  constructor(init?: { gid?: string; id?: number }) {
    this.gid = init?.gid ?? getUniqueId()
    this.id = init?.id ?? 0
    this.name = this.constructor.name
    this.timestamp = String(getUtcTimestamp())
  }

  /** Serialize to a plain dict suitable for msgpack encoding. */
  toDict(): FrameDict {
    const dict: FrameDict = {}
    for (const key of Object.keys(this)) {
      dict[key] = (this as Record<string, unknown>)[key]
    }
    return dict
  }

  /**
   * Register a subclass factory so Frame.fromDict() can dispatch by name.
   * Call Frame.register(MyFrame) once after each subclass definition.
   */
  static register(name: string, factory: (data: FrameDict) => Frame): void {
    _registry.set(name, factory)
  }

  /**
   * Reconstruct a Frame subclass from a wire-format dict.
   * Dispatches via the 'name' field to the registered subclass factory.
   * Falls back to a plain Frame (base metadata only) if name is unknown.
   */
  static fromDict(data: FrameDict): Frame {
    const name = data['name'] as string | undefined
    if (name) {
      const factory = _registry.get(name)
      if (factory) return factory(data)
    }
    // Fallback: plain Frame with base fields preserved
    return new Frame({ gid: data['gid'] as string, id: data['id'] as number })
  }
}
