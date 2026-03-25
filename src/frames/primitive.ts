import { Frame, FrameDict } from './Frame'

export class BoolFrame extends Frame {
  value: boolean

  constructor(init?: { gid?: string; id?: number; value?: boolean }) {
    super(init)
    this.value = init?.value ?? false
  }
}
Frame.register('BoolFrame', (d: FrameDict) => new BoolFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as boolean,
}))


export class IntFrame extends Frame {
  value: number

  constructor(init?: { gid?: string; id?: number; value?: number }) {
    super(init)
    this.value = init?.value ?? 0
  }
}
Frame.register('IntFrame', (d: FrameDict) => new IntFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as number,
}))


export class FloatFrame extends Frame {
  value: number

  constructor(init?: { gid?: string; id?: number; value?: number }) {
    super(init)
    this.value = init?.value ?? 0.0
  }
}
Frame.register('FloatFrame', (d: FrameDict) => new FloatFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as number,
}))


export class StringFrame extends Frame {
  value: string

  constructor(init?: { gid?: string; id?: number; value?: string }) {
    super(init)
    this.value = init?.value ?? ''
  }
}
Frame.register('StringFrame', (d: FrameDict) => new StringFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as string,
}))


export class BytesFrame extends Frame {
  value: Uint8Array

  constructor(init?: { gid?: string; id?: number; value?: Uint8Array | ArrayBuffer | number[] }) {
    super(init)
    const v = init?.value
    if (v instanceof Uint8Array) {
      this.value = v
    } else if (v instanceof ArrayBuffer) {
      this.value = new Uint8Array(v)
    } else if (Array.isArray(v)) {
      this.value = new Uint8Array(v)
    } else {
      this.value = new Uint8Array(0)
    }
  }
}
Frame.register('BytesFrame', (d: FrameDict) => new BytesFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as Uint8Array,
}))


export class DictFrame extends Frame {
  value: Record<string, unknown>

  constructor(init?: { gid?: string; id?: number; value?: Record<string, unknown> }) {
    super(init)
    this.value = init?.value ?? {}
  }
}
Frame.register('DictFrame', (d: FrameDict) => new DictFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as Record<string, unknown>,
}))


export class ListFrame extends Frame {
  value: unknown[]

  constructor(init?: { gid?: string; id?: number; value?: unknown[] }) {
    super(init)
    this.value = init?.value ?? []
  }
}
Frame.register('ListFrame', (d: FrameDict) => new ListFrame({
  gid: d['gid'] as string, id: d['id'] as number, value: d['value'] as unknown[],
}))
