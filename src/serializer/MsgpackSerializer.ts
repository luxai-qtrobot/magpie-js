import { encode, decode } from '@msgpack/msgpack'
import { BaseSerializer } from './BaseSerializer'

/**
 * Msgpack serializer — wire-compatible with Python's msgpack.packb / msgpack.unpackb
 * (uses_bin_type=True, raw=False defaults in msgpack >= 1.0).
 *
 * Binary fields (e.g. image/audio data) arrive as Uint8Array.
 * String keys and values are decoded as UTF-8 strings.
 */
export class MsgpackSerializer extends BaseSerializer {
  serialize(data: unknown): Uint8Array {
    return encode(data)
  }

  deserialize(data: Uint8Array | ArrayBuffer): unknown {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    return decode(bytes)
  }
}
