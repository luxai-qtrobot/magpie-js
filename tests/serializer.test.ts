import { describe, it, expect } from 'vitest'
import { MsgpackSerializer } from '../src/serializer/MsgpackSerializer'

const s = new MsgpackSerializer()

describe('MsgpackSerializer', () => {

  it('roundtrips a plain dict', () => {
    const data = { count: 42, msg: 'hello' }
    expect(s.deserialize(s.serialize(data))).toEqual(data)
  })

  it('roundtrips nested objects', () => {
    const data = { a: { b: { c: 123 } }, list: [1, 2, 3] }
    expect(s.deserialize(s.serialize(data))).toEqual(data)
  })

  it('roundtrips numbers — int, float, negative', () => {
    expect(s.deserialize(s.serialize(0))).toBe(0)
    expect(s.deserialize(s.serialize(3.14))).toBeCloseTo(3.14)
    expect(s.deserialize(s.serialize(-99))).toBe(-99)
  })

  it('roundtrips a string', () => {
    expect(s.deserialize(s.serialize('magpie'))).toBe('magpie')
  })

  it('roundtrips null', () => {
    expect(s.deserialize(s.serialize(null))).toBeNull()
  })

  it('roundtrips a boolean', () => {
    expect(s.deserialize(s.serialize(true))).toBe(true)
    expect(s.deserialize(s.serialize(false))).toBe(false)
  })

  it('roundtrips binary data as Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0])
    const result = s.deserialize(s.serialize(bytes)) as Uint8Array
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result).toEqual(bytes)
  })

  it('accepts ArrayBuffer in deserialize', () => {
    const data = { x: 1 }
    const encoded = s.serialize(data)
    const ab = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
    expect(s.deserialize(ab)).toEqual(data)
  })

  it('produces bytes (Uint8Array)', () => {
    expect(s.serialize({ a: 1 })).toBeInstanceOf(Uint8Array)
  })

  // Interop: verify Python msgpack produces identical bytes for a known payload.
  // Python: msgpack.packb({'count': 1, 'msg': 'hello'})
  it('wire format matches Python msgpack encoding', () => {
    const pyBytes = new Uint8Array([
      0x82,                               // fixmap, 2 entries
      0xa5, 0x63, 0x6f, 0x75, 0x6e, 0x74, // 'count'
      0x01,                               // 1
      0xa3, 0x6d, 0x73, 0x67,             // 'msg'
      0xa5, 0x68, 0x65, 0x6c, 0x6c, 0x6f  // 'hello'
    ])
    expect(s.serialize({ count: 1, msg: 'hello' })).toEqual(pyBytes)
  })
})
