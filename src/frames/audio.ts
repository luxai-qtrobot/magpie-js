import { Frame, FrameDict } from './Frame'

/**
 * Raw PCM audio frame.
 * `data` holds interleaved PCM samples as raw bytes (Uint8Array).
 * Wire format matches Python's AudioFrameRaw exactly.
 */
export class AudioFrameRaw extends Frame {
  channels: number
  sampleRate: number    // wire key: 'sample_rate'
  bitDepth: number      // wire key: 'bit_depth'
  format: string
  data: Uint8Array

  constructor(init?: {
    gid?: string
    id?: number
    channels?: number
    sampleRate?: number
    bitDepth?: number
    format?: string
    data?: Uint8Array | ArrayBuffer
  }) {
    super(init)
    this.channels = init?.channels ?? 1
    this.sampleRate = init?.sampleRate ?? 16000
    this.bitDepth = init?.bitDepth ?? 16
    this.format = init?.format ?? 'PCM'
    const d = init?.data
    this.data = d instanceof ArrayBuffer ? new Uint8Array(d) : (d ?? new Uint8Array(0))
  }

  // Python uses snake_case keys on the wire
  toDict(): FrameDict {
    const dict = super.toDict()
    delete dict['sampleRate']
    delete dict['bitDepth']
    dict['sample_rate'] = this.sampleRate
    dict['bit_depth'] = this.bitDepth
    return dict
  }

  /** Number of PCM frames in `data`. */
  get numFrames(): number {
    return Math.floor(this.data.byteLength / (this.channels * this.bitDepth / 8))
  }
}
Frame.register('AudioFrameRaw', (d: FrameDict) => new AudioFrameRaw({
  gid: d['gid'] as string,
  id: d['id'] as number,
  channels: d['channels'] as number,
  sampleRate: d['sample_rate'] as number,
  bitDepth: d['bit_depth'] as number,
  format: d['format'] as string,
  data: d['data'] as Uint8Array,
}))


/**
 * FLAC-encoded audio frame.
 * `data` holds the FLAC-compressed bytes. Decoding is left to the application
 * (e.g. via Web Audio API + an appropriate FLAC decoder).
 */
export class AudioFrameFlac extends AudioFrameRaw {
  constructor(init?: ConstructorParameters<typeof AudioFrameRaw>[0]) {
    super({ ...init, format: 'FLAC' })
  }
}
Frame.register('AudioFrameFlac', (d: FrameDict) => new AudioFrameFlac({
  gid: d['gid'] as string,
  id: d['id'] as number,
  channels: d['channels'] as number,
  sampleRate: d['sample_rate'] as number,
  bitDepth: d['bit_depth'] as number,
  data: d['data'] as Uint8Array,
}))
