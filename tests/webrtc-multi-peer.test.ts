import { describe, expect, it, vi } from 'vitest'
import { MsgpackSerializer } from '../src/serializer/MsgpackSerializer'
import { WebRtcConnection, WebRtcSignaler } from '../src/transport/webrtc'

class MemorySignaler extends WebRtcSignaler {
  private callback: ((payload: Uint8Array) => void) | null = null
  readonly sent: Uint8Array[] = []
  get sessionId(): string { return 'room' }
  publish(payload: Uint8Array): void { this.sent.push(payload) }
  subscribe(callback: (payload: Uint8Array) => void): void { this.callback = callback }
  unsubscribe(): void { this.callback = null }
  async disconnect(): Promise<void> { this.callback = null }
  receive(payload: Uint8Array): void { this.callback?.(payload) }
}

function fakePeer() {
  const services = new Map<string, (msg: unknown) => void>()
  const subscriptions = new Map<string, (payload: unknown, topic: string) => void>()
  return {
    isDataReady: true,
    sendData: vi.fn(),
    sendMediaFrame: vi.fn(),
    addPubCallback: (topic: string, callback: (payload: unknown, topic: string) => void) => subscriptions.set(topic, callback),
    deliverPub: (topic: string, payload: unknown) => subscriptions.get(topic)?.(payload, topic),
    addRpcService: (name: string, callback: (msg: unknown) => void) => services.set(name, callback),
    removeRpcService: (name: string) => services.delete(name),
    deliverRequest: (name: string, message: unknown) => services.get(name)?.(message),
  }
}

describe('WebRTC connection multi-peer routing', () => {
  it('fans out publications and routes each RPC reply to its requester', () => {
    const connection = new WebRtcConnection(new MemorySignaler())
    const a = fakePeer()
    const b = fakePeer()
    const internals = connection as unknown as { _peers: Map<string, unknown> }
    internals._peers.set('a', a)
    internals._peers.set('b', b)

    connection.sendData({ type: 'pub', topic: 'state', payload: { value: 1 } })
    expect(a.sendData).toHaveBeenCalledTimes(1)
    expect(b.sendData).toHaveBeenCalledTimes(1)

    const received: unknown[] = []
    connection.addPubCallback('state', payload => received.push(payload))
    a.deliverPub('state', { source: 'a' })
    b.deliverPub('state', { source: 'b' })
    expect(received).toEqual([{ source: 'a' }, { source: 'b' }])

    connection.addRpcService('echo', () => undefined)
    a.deliverRequest('echo', { type: 'rpc_req', rid: 'request-a', payload: 1 })
    b.deliverRequest('echo', { type: 'rpc_req', rid: 'request-b', payload: 2 })
    connection.sendData({ type: 'rpc_ack', rid: 'request-a' })
    connection.sendData({ type: 'rpc_rep', rid: 'request-b', payload: 2 })
    expect(a.sendData).toHaveBeenCalledWith({ type: 'rpc_ack', rid: 'request-a' })
    expect(a.sendData).not.toHaveBeenCalledWith({ type: 'rpc_rep', rid: 'request-b', payload: 2 })
    expect(b.sendData).toHaveBeenCalledWith({ type: 'rpc_rep', rid: 'request-b', payload: 2 })
    expect(b.sendData).not.toHaveBeenCalledWith({ type: 'rpc_ack', rid: 'request-a' })
  })

  it('does not create a client-to-client WebRTC link', async () => {
    const signaler = new MemorySignaler()
    const connection = new WebRtcConnection(signaler, { role: 'client' })
    const result = connection.connect(0.01)
    signaler.receive(new MsgpackSerializer().serialize({
      type: 'hello', peer_id: 'another-client', role: 'client',
    }))
    expect(connection.peerIds).toEqual([])
    expect((connection as unknown as { _peers: Map<string, unknown> })._peers.size).toBe(0)
    expect(await result).toBe(false)
    await connection.disconnect()
  })
})
