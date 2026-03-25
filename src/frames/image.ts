import { Frame, FrameDict } from './Frame'

/**
 * Raw or encoded image frame.
 * `data` holds the pixel or encoded bytes (Uint8Array on the JS side).
 * All metadata matches the Python ImageFrameRaw wire format exactly.
 */
export class ImageFrameRaw extends Frame {
  data: Uint8Array
  format: string
  width: number
  height: number
  channels: number
  pixelFormat: string   // wire key: 'pixel_format' — see toDict() override

  constructor(init?: {
    gid?: string
    id?: number
    data?: Uint8Array | ArrayBuffer
    format?: string
    width?: number
    height?: number
    channels?: number
    pixelFormat?: string
  }) {
    super(init)
    const d = init?.data
    this.data = d instanceof ArrayBuffer ? new Uint8Array(d) : (d ?? new Uint8Array(0))
    this.format = init?.format ?? 'raw'
    this.width = init?.width ?? 0
    this.height = init?.height ?? 0
    this.channels = init?.channels ?? 0
    this.pixelFormat = init?.pixelFormat ?? ''
  }

  // Python uses snake_case 'pixel_format' on the wire
  toDict(): FrameDict {
    const dict = super.toDict()
    delete dict['pixelFormat']
    dict['pixel_format'] = this.pixelFormat
    return dict
  }
}
Frame.register('ImageFrameRaw', (d: FrameDict) => new ImageFrameRaw({
  gid: d['gid'] as string,
  id: d['id'] as number,
  data: d['data'] as Uint8Array,
  format: d['format'] as string,
  width: d['width'] as number,
  height: d['height'] as number,
  channels: d['channels'] as number,
  pixelFormat: d['pixel_format'] as string,
}))


/**
 * JPEG-encoded image frame. Same wire format as ImageFrameRaw with format='jpeg'.
 * Decoding (e.g. via canvas or a JPEG library) is left to the application.
 */
export class ImageFrameJpeg extends ImageFrameRaw {
  constructor(init?: ConstructorParameters<typeof ImageFrameRaw>[0]) {
    super({ ...init, format: init?.format && init.format !== 'raw' ? init.format : 'jpeg' })
  }
}
Frame.register('ImageFrameJpeg', (d: FrameDict) => new ImageFrameJpeg({
  gid: d['gid'] as string,
  id: d['id'] as number,
  data: d['data'] as Uint8Array,
  format: d['format'] as string,
  width: d['width'] as number,
  height: d['height'] as number,
  channels: d['channels'] as number,
  pixelFormat: d['pixel_format'] as string,
}))
