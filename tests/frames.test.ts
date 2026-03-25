import { describe, it, expect } from 'vitest'
import { Frame } from '../src/frames/Frame'
import {
  BoolFrame, IntFrame, FloatFrame, StringFrame,
  BytesFrame, DictFrame, ListFrame,
} from '../src/frames/primitive'
import { ImageFrameRaw, ImageFrameJpeg } from '../src/frames/image'
import { AudioFrameRaw, AudioFrameFlac } from '../src/frames/audio'

// ─────────────────────────────────────────────────────────────────────────────
// Frame base
// ─────────────────────────────────────────────────────────────────────────────

describe('Frame base', () => {
  it('generates a gid and id=0 by default', () => {
    const f = new DictFrame()
    expect(typeof f.gid).toBe('string')
    expect(f.gid.length).toBeGreaterThan(0)
    expect(f.id).toBe(0)
  })

  it('preserves gid and id from init', () => {
    const f = new DictFrame({ gid: 'MY-GID', id: 7 })
    expect(f.gid).toBe('MY-GID')
    expect(f.id).toBe(7)
  })

  it('sets name to the class name', () => {
    expect(new DictFrame().name).toBe('DictFrame')
    expect(new IntFrame().name).toBe('IntFrame')
    expect(new AudioFrameRaw().name).toBe('AudioFrameRaw')
  })

  it('timestamp is a string representation of a float (UTC seconds)', () => {
    const f = new DictFrame()
    const t = parseFloat(f.timestamp)
    expect(isNaN(t)).toBe(false)
    // Should be a recent Unix timestamp (after 2024-01-01)
    expect(t).toBeGreaterThan(1_700_000_000)
  })

  it('toDict includes all own properties', () => {
    const f = new DictFrame({ value: { x: 1 } })
    const d = f.toDict()
    expect(d).toHaveProperty('gid')
    expect(d).toHaveProperty('id')
    expect(d).toHaveProperty('name', 'DictFrame')
    expect(d).toHaveProperty('timestamp')
    expect(d).toHaveProperty('value', { x: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Frame.fromDict dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('Frame.fromDict', () => {
  it('dispatches to DictFrame by name', () => {
    const f = new DictFrame({ value: { hello: 'world' } })
    const restored = Frame.fromDict(f.toDict())
    expect(restored).toBeInstanceOf(DictFrame)
    expect((restored as DictFrame).value).toEqual({ hello: 'world' })
  })

  it('dispatches to IntFrame by name', () => {
    const restored = Frame.fromDict({ ...new IntFrame({ value: 42 }).toDict() })
    expect(restored).toBeInstanceOf(IntFrame)
    expect((restored as IntFrame).value).toBe(42)
  })

  it('dispatches to BoolFrame by name', () => {
    const restored = Frame.fromDict({ ...new BoolFrame({ value: true }).toDict() })
    expect((restored as BoolFrame).value).toBe(true)
  })

  it('falls back gracefully for unknown frame name', () => {
    const restored = Frame.fromDict({ gid: 'x', id: 0, name: 'UnknownFrame', timestamp: '0' })
    expect(restored).toBeInstanceOf(Frame)
  })

  it('falls back gracefully when name is missing', () => {
    const restored = Frame.fromDict({ gid: 'x', id: 0 })
    expect(restored).toBeInstanceOf(Frame)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Primitive frames
// ─────────────────────────────────────────────────────────────────────────────

describe('Primitive frames', () => {
  it('BoolFrame defaults to false', () => expect(new BoolFrame().value).toBe(false))
  it('IntFrame defaults to 0', () => expect(new IntFrame().value).toBe(0))
  it('FloatFrame defaults to 0.0', () => expect(new FloatFrame().value).toBe(0.0))
  it('StringFrame defaults to empty string', () => expect(new StringFrame().value).toBe(''))
  it('ListFrame defaults to []', () => expect(new ListFrame().value).toEqual([]))
  it('DictFrame defaults to {}', () => expect(new DictFrame().value).toEqual({}))

  it('BytesFrame normalizes ArrayBuffer to Uint8Array', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer
    const f = new BytesFrame({ value: buf as ArrayBuffer })
    expect(f.value).toBeInstanceOf(Uint8Array)
    expect(f.value).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('BytesFrame normalizes number[] to Uint8Array', () => {
    const f = new BytesFrame({ value: [10, 20, 30] })
    expect(f.value).toBeInstanceOf(Uint8Array)
    expect(f.value).toEqual(new Uint8Array([10, 20, 30]))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ImageFrameRaw / ImageFrameJpeg — wire format (Python interop critical)
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageFrameRaw wire format', () => {
  it('toDict uses snake_case pixel_format (not pixelFormat)', () => {
    const f = new ImageFrameRaw({ width: 640, height: 480, channels: 3, pixelFormat: 'BGR' })
    const d = f.toDict()
    expect(d).toHaveProperty('pixel_format', 'BGR')
    expect(d).not.toHaveProperty('pixelFormat')
  })

  it('toDict includes all image fields', () => {
    const f = new ImageFrameRaw({
      data: new Uint8Array([0xff, 0x00]),
      format: 'raw',
      width: 2, height: 1, channels: 1,
      pixelFormat: 'GRAY',
    })
    const d = f.toDict()
    expect(d['width']).toBe(2)
    expect(d['height']).toBe(1)
    expect(d['channels']).toBe(1)
    expect(d['format']).toBe('raw')
    expect(d['pixel_format']).toBe('GRAY')
  })

  it('fromDict restores pixelFormat from snake_case pixel_format', () => {
    const wire = {
      gid: 'g', id: 0, name: 'ImageFrameRaw', timestamp: '0',
      data: new Uint8Array([1]), format: 'raw',
      width: 4, height: 4, channels: 3, pixel_format: 'RGB',
    }
    const f = Frame.fromDict(wire) as ImageFrameRaw
    expect(f).toBeInstanceOf(ImageFrameRaw)
    expect(f.pixelFormat).toBe('RGB')
  })

  it('ImageFrameJpeg defaults format to jpeg', () => {
    expect(new ImageFrameJpeg().format).toBe('jpeg')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AudioFrameRaw / AudioFrameFlac — wire format (Python interop critical)
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioFrameRaw wire format', () => {
  it('toDict uses snake_case sample_rate and bit_depth', () => {
    const f = new AudioFrameRaw({ sampleRate: 44100, bitDepth: 16, channels: 2 })
    const d = f.toDict()
    expect(d).toHaveProperty('sample_rate', 44100)
    expect(d).toHaveProperty('bit_depth', 16)
    expect(d).not.toHaveProperty('sampleRate')
    expect(d).not.toHaveProperty('bitDepth')
  })

  it('fromDict restores sampleRate/bitDepth from snake_case keys', () => {
    const wire = {
      gid: 'g', id: 0, name: 'AudioFrameRaw', timestamp: '0',
      channels: 2, sample_rate: 48000, bit_depth: 16,
      format: 'PCM', data: new Uint8Array(0),
    }
    const f = Frame.fromDict(wire) as AudioFrameRaw
    expect(f).toBeInstanceOf(AudioFrameRaw)
    expect(f.sampleRate).toBe(48000)
    expect(f.bitDepth).toBe(16)
  })

  it('numFrames computes correctly', () => {
    // 2 channels × 2 bytes (16-bit) = 4 bytes per frame → 8 bytes = 2 frames
    const f = new AudioFrameRaw({
      data: new Uint8Array(8), channels: 2, bitDepth: 16,
    })
    expect(f.numFrames).toBe(2)
  })

  it('AudioFrameFlac defaults format to FLAC', () => {
    expect(new AudioFrameFlac().format).toBe('FLAC')
  })
})
