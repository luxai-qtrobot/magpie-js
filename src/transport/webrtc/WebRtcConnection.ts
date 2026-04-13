/**
 * WebRtcConnection — shared WebRTC peer connection for MAGPIE (browser).
 *
 * Architecture overview
 * ---------------------
 * - One WebRtcConnection per peer pair, shared by all publishers, subscribers,
 *   and RPC components — mirroring MqttConnection.
 * - Uses the browser's native RTCPeerConnection; no extra dependencies needed.
 * - Signaling (SDP offer/answer + ICE candidates) is exchanged via a
 *   WebRtcSignaler — use MqttSignaler for internet connectivity.
 * - Role (offer vs answer) is auto-negotiated: both peers broadcast a "hello"
 *   message; the peer with the lexicographically higher peerId creates the offer.
 * - Data channel routing uses the same wire envelope as Python:
 *     { type: "pub" | "rpc_req" | "rpc_ack" | "rpc_rep", ... }
 * - Incoming video/audio tracks are exposed via callbacks (MediaStreamTrack).
 * - Local video/audio tracks can be added before connect() for sending media.
 *
 * Wire protocol is 100% compatible with Python's WebRTCConnection.
 */

import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { Logger } from '../../utils/logger'
import { getUniqueId } from '../../utils/common'
import { MqttOptions } from '../mqtt/MqttOptions'
import { WebRtcOptions, WebRtcTurnServer } from './WebRtcOptions'
import { WebRtcSignaler, MqttSignaler } from './WebRtcSignaler'

type PubCallback = (payload: unknown, topic: string) => void
type RpcCallback = (msg: unknown) => void
/** Video callback: receives a MediaStreamTrack (media track path) or a
 *  raw frame dict (magpie-media fallback path when media tracks are not negotiated). */
type VideoCallback = (data: MediaStreamTrack | Record<string, unknown>) => void
/** Audio callback: receives a MediaStreamTrack (media track path) or a
 *  raw frame dict (magpie-media fallback path). */
type AudioCallback = (data: MediaStreamTrack | Record<string, unknown>) => void


export class WebRtcConnection {
  // ---- Identity -----------------------------------------------------------
  readonly sessionId: string
  private _peerId: string

  // ---- Config -------------------------------------------------------------
  private readonly _signaler: WebRtcSignaler
  private readonly _reconnect: boolean
  private readonly _opts: Required<Omit<WebRtcOptions, 'dataChannelMaxRetransmits'>> & Pick<WebRtcOptions, 'dataChannelMaxRetransmits'>
  private readonly _serializer = new MsgpackSerializer()

  // ---- WebRTC objects -----------------------------------------------------
  private _pc: RTCPeerConnection | null = null
  private _dataChannel: RTCDataChannel | null = null
  // ---- magpie-media unreliable channel (audio/video fallback, useMediaChannels=true only) ----
  private _mediaChannel: RTCDataChannel | null = null
  private _videoNegotiated = false
  private _audioNegotiated = false

  // ---- Drop-stale media send (useMediaChannels=false path) ----------------
  private _pendingMediaSend: Uint8Array | null = null
  private _mediaSendScheduled = false

  // ---- Local media (set before connect()) ---------------------------------
  private _localVideoTrack: MediaStreamTrack | null = null
  private _localAudioTrack: MediaStreamTrack | null = null

  // ---- Signaling state ----------------------------------------------------
  private _remotePeerId: string | null = null
  private _roleDecided = false
  private _pendingIceCandidates: RTCIceCandidateInit[] = []

  // ---- Connection state ---------------------------------------------------
  private _connected = false
  private _closing = false
  private _connectResolve: ((value: boolean) => void) | null = null
  private _connectTimer: ReturnType<typeof setTimeout> | null = null
  private _helloTimer: ReturnType<typeof setTimeout> | null = null

  // ---- Message routing ----------------------------------------------------
  private _pubCallbacks = new Map<string, Set<PubCallback>>()
  private _rpcServiceCallbacks = new Map<string, RpcCallback>()
  private _rpcReplyCallbacks = new Map<string, RpcCallback>()
  private _videoCallbacks: VideoCallback[] = []
  private _audioCallbacks: AudioCallback[] = []

  // ---- Last received media tracks (for late subscribers) ------------------
  private _lastVideoTrack: MediaStreamTrack | null = null
  private _lastAudioTrack: MediaStreamTrack | null = null

  // ---- Bound signal handler (stable reference for unsubscribe) ------------
  private readonly _boundSignalHandler: (payload: Uint8Array) => void

  // -------------------------------------------------------------------------

  constructor(
    signaler: WebRtcSignaler,
    options?: {
      reconnect?: boolean
      webrtcOptions?: WebRtcOptions
    },
  ) {
    this._signaler = signaler
    this._reconnect = options?.reconnect ?? false
    this.sessionId = signaler.sessionId
    this._peerId = getUniqueId().slice(0, 12)
    this._boundSignalHandler = this._onSignalMessage.bind(this)

    const o = options?.webrtcOptions ?? {}
    this._opts = {
      stunServers: o.stunServers ?? ['stun:stun.l.google.com:19302'],
      turnServers: o.turnServers ?? [],
      iceTransportPolicy: o.iceTransportPolicy ?? 'all',
      dataChannelOrdered: o.dataChannelOrdered ?? true,
      dataChannelMaxRetransmits: o.dataChannelMaxRetransmits,
      useMediaChannels: o.useMediaChannels ?? true,
      mediaChannelJpegQuality: o.mediaChannelJpegQuality ?? 80,
    }

    Logger.debug(`WebRtcConnection: peerId=${this._peerId}, sessionId=${this.sessionId}`)
  }

  // ---- Static factories ---------------------------------------------------

  /**
   * Create a WebRtcConnection using MQTT as the signaling transport.
   * This is the standard factory for browser use over the internet.
   *
   * @param brokerUrl  MQTT broker URI. Use wss:// in the browser, e.g.
   *                   wss://broker.hivemq.com:8884/mqtt
   * @param sessionId  Shared rendezvous name — must match the remote peer.
   * @param options    Optional MQTT auth, WebRTC ICE config, reconnect flag.
   *
   * Example:
   *   const conn = await WebRtcConnection.withMqtt(
   *     'wss://broker.hivemq.com:8884/mqtt', 'my-robot'
   *   )
   *   await conn.connect(30)
   */
  static async withMqtt(
    brokerUrl: string,
    sessionId: string,
    options?: {
      clientId?: string
      timeout?: number
      mqttOptions?: MqttOptions
      reconnect?: boolean
      webrtcOptions?: WebRtcOptions
    },
  ): Promise<WebRtcConnection> {
    const signaler = await MqttSignaler.create(brokerUrl, sessionId, {
      ...options?.mqttOptions,
      clientId: options?.clientId,
      timeout: options?.timeout,
    })
    return new WebRtcConnection(signaler, {
      reconnect: options?.reconnect ?? false,
      webrtcOptions: options?.webrtcOptions,
    })
  }

  // ---- Public API ---------------------------------------------------------

  get peerId(): string { return this._peerId }
  get isConnected(): boolean { return this._connected }
  /** True if a native video media track was established with the remote peer. */
  get videoNegotiated(): boolean { return this._videoNegotiated }
  /** True if a native audio media track was established with the remote peer. */
  get audioNegotiated(): boolean { return this._audioNegotiated }
  /** Whether native WebRTC media tracks are used for video/audio (vs data channel). */
  get useMediaChannels(): boolean { return this._opts.useMediaChannels }
  /** Last received remote video track, or null if none has arrived yet. */
  get videoTrack(): MediaStreamTrack | null { return this._lastVideoTrack }
  /** Last received remote audio track, or null if none has arrived yet. */
  get audioTrack(): MediaStreamTrack | null { return this._lastAudioTrack }
  /** JPEG quality (1–100) used when compressing frames sent over the data channel. */
  get mediaChannelJpegQuality(): number { return this._opts.mediaChannelJpegQuality ?? 80 }

  /**
   * Add a local video track to be sent to the remote peer.
   * Must be called before connect().
   * Obtain a track from getUserMedia() or HTMLCanvasElement.captureStream().
   */
  setLocalVideoTrack(track: MediaStreamTrack): void {
    this._localVideoTrack = track
  }

  /**
   * Add a local audio track to be sent to the remote peer.
   * Must be called before connect().
   */
  setLocalAudioTrack(track: MediaStreamTrack): void {
    this._localAudioTrack = track
  }

  /**
   * Initiate the WebRTC handshake and wait until the peer connection is
   * established or timeout seconds elapse.
   *
   * @param timeout  Max seconds to wait. Undefined = wait indefinitely
   *                 (hello loop runs for 30 s then gives up).
   * @returns        true on success, false on timeout or failure.
   */
  connect(timeout?: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this._connectResolve = resolve
      this._closing = false

      if (timeout !== undefined) {
        this._connectTimer = setTimeout(() => {
          Logger.warning(
            `WebRtcConnection(${this._peerId}): connect timed out after ${timeout}s`,
          )
          this._resolveConnect(false)
        }, timeout * 1000)
      }

      this._signaler.subscribe(this._boundSignalHandler)

      this._connectInner().catch(e => {
        Logger.error(`WebRtcConnection: setup error: ${e}`)
        this._resolveConnect(false)
      })
    })
  }

  /**
   * Close the peer connection, signaler, and release all resources.
   */
  async disconnect(): Promise<void> {
    this._closing = true
    this._connected = false
    this._clearHelloTimer()
    this._signaler.unsubscribe()

    if (this._pc) {
      this._pc.close()
      this._pc = null
    }
    this._dataChannel = null
    this._mediaChannel = null

    await this._signaler.disconnect()
    Logger.debug(`WebRtcConnection(${this._peerId}): disconnected.`)
  }

  // ---- Registration API (used by publisher / subscriber / rpc classes) ----

  addPubCallback(topic: string, callback: PubCallback): void {
    if (!this._pubCallbacks.has(topic)) this._pubCallbacks.set(topic, new Set())
    this._pubCallbacks.get(topic)!.add(callback)
  }

  removePubCallback(topic: string, callback: PubCallback): void {
    this._pubCallbacks.get(topic)?.delete(callback)
  }

  addRpcService(service: string, callback: RpcCallback): void {
    this._rpcServiceCallbacks.set(service, callback)
  }

  removeRpcService(service: string): void {
    this._rpcServiceCallbacks.delete(service)
  }

  registerRpcReply(rid: string, callback: RpcCallback): void {
    this._rpcReplyCallbacks.set(rid, callback)
  }

  unregisterRpcReply(rid: string): void {
    this._rpcReplyCallbacks.delete(rid)
  }

  /**
   * Register a callback that fires when a remote video track arrives.
   * The callback receives a live MediaStreamTrack; attach it to a <video>
   * element via: videoElement.srcObject = new MediaStream([track])
   */
  addVideoCallback(callback: VideoCallback): void {
    this._videoCallbacks.push(callback)
    if (this._lastVideoTrack !== null) {
      try { callback(this._lastVideoTrack) } catch (e) {
        Logger.warning(`WebRtcConnection(${this._peerId}): video callback error: ${e}`)
      }
    }
  }

  removeVideoCallback(callback: VideoCallback): void {
    this._videoCallbacks = this._videoCallbacks.filter(cb => cb !== callback)
  }

  /**
   * Register a callback that fires when a remote audio track arrives.
   */
  addAudioCallback(callback: AudioCallback): void {
    this._audioCallbacks.push(callback)
    if (this._lastAudioTrack !== null) {
      try { callback(this._lastAudioTrack) } catch (e) {
        Logger.warning(`WebRtcConnection(${this._peerId}): audio callback error: ${e}`)
      }
    }
  }

  removeAudioCallback(callback: AudioCallback): void {
    this._audioCallbacks = this._audioCallbacks.filter(cb => cb !== callback)
  }

  /**
   * Serialize msg as msgpack and send it on the data channel.
   * Silently drops the message if the channel is not open yet.
   */
  sendData(msg: unknown): void {
    if (!this._dataChannel || this._dataChannel.readyState !== 'open') return
    try {
      const payload = this._serializer.serialize(msg)
      this._dataChannel.send(payload as Uint8Array<ArrayBuffer>)
    } catch (e) {
      Logger.warning(`WebRtcConnection(${this._peerId}): sendData failed: ${e}`)
    }
  }

  /**
   * Send a video or audio frame on the magpie-media unreliable data channel.
   * Use when the remote peer does not support media tracks (e.g. the C++ port).
   * msg should be: { kind: 'video'|'audio', topic: string, payload: <frame-dict> }
   */
  sendMediaFrame(msg: unknown): void {
    if (!this._mediaChannel || this._mediaChannel.readyState !== 'open') return
    try {
      const payload = this._serializer.serialize(msg)
      this._mediaChannel.send(payload as Uint8Array<ArrayBuffer>)
    } catch (e) {
      Logger.warning(`WebRtcConnection(${this._peerId}): sendMediaFrame failed: ${e}`)
    }
  }

  /**
   * Enqueue a pre-serialized media frame for sending via the reliable data channel.
   * Used when useMediaChannels=false. Drop-stale: only the latest pending frame is kept,
   * so a slow consumer never accumulates a backlog of stale video frames.
   */
  enqueueMediaSend(payload: Uint8Array): void {
    this._pendingMediaSend = payload
    if (!this._mediaSendScheduled) {
      this._mediaSendScheduled = true
      setTimeout(() => {
        this._mediaSendScheduled = false
        const data = this._pendingMediaSend
        this._pendingMediaSend = null
        if (!data) return
        if (this._dataChannel && this._dataChannel.readyState === 'open') {
          try {
            this._dataChannel.send(data as unknown as Uint8Array<ArrayBuffer>)
          } catch (e) {
            Logger.warning(`WebRtcConnection(${this._peerId}): enqueueMediaSend failed: ${e}`)
          }
        }
      }, 0)
    }
  }

  // ---- Private: connection setup ------------------------------------------

  private _resolveConnect(value: boolean): void {
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null }
    if (this._connectResolve) { this._connectResolve(value); this._connectResolve = null }
  }

  private _clearHelloTimer(): void {
    if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null }
  }

  private async _connectInner(): Promise<void> {
    const iceServers: RTCIceServer[] = this._opts.stunServers.map(url => ({ urls: url }))
    for (const turn of this._opts.turnServers as WebRtcTurnServer[]) {
      iceServers.push({ urls: turn.url, username: turn.username, credential: turn.credential })
    }

    this._pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this._opts.iceTransportPolicy })
    this._setupPcHandlers()
    this._startHelloLoop()
  }

  private _setupPcHandlers(): void {
    const pc = this._pc!

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      Logger.debug(`WebRtcConnection(${this._peerId}): state → ${state}`)

      if (state === 'connected') {
        this._connected = true
        // _resolveConnect(true) is called from _setupDataChannel's onopen,
        // matching Python behaviour: connect() only resolves once the data
        // channel is ready to send (not just when ICE is established).
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this._connected = false
        this._resolveConnect(false)
        if (this._reconnect && !this._closing) {
          Logger.info(
            `WebRtcConnection(${this._peerId}): connection ${state} — reconnecting...`,
          )
          this._reconnectAsync()
        }
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignal({
          type: 'candidate',
          peer_id: this._peerId,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        })
      }
    }

    pc.ondatachannel = (event) => {
      if (event.channel.label === 'magpie') {
        this._dataChannel = event.channel
        this._setupDataChannel(event.channel)
      } else if (event.channel.label === 'magpie-media' && this._opts.useMediaChannels) {
        // magpie-media is only used as fallback when useMediaChannels=true
        this._mediaChannel = event.channel
        this._setupMediaChannel(event.channel)
      }
    }

    pc.ontrack = (event) => {
      const track = event.track
      if (track.kind === 'video') {
        // Only set negotiated when we actually sent a local video track (publisher side)
        if (this._opts.useMediaChannels && this._localVideoTrack !== null) {
          this._videoNegotiated = true
        }
        this._lastVideoTrack = track
        for (const cb of [...this._videoCallbacks]) {
          try { cb(track) } catch (e) {
            Logger.warning(`WebRtcConnection(${this._peerId}): video callback error: ${e}`)
          }
        }
      } else if (track.kind === 'audio') {
        // Only set negotiated when we actually sent a local audio track (publisher side)
        if (this._opts.useMediaChannels && this._localAudioTrack !== null) {
          this._audioNegotiated = true
        }
        this._lastAudioTrack = track
        for (const cb of [...this._audioCallbacks]) {
          try { cb(track) } catch (e) {
            Logger.warning(`WebRtcConnection(${this._peerId}): audio callback error: ${e}`)
          }
        }
      }
    }
  }

  // ---- Private: hello loop ------------------------------------------------

  private _startHelloLoop(): void {
    let count = 0

    const tick = () => {
      if (this._closing) return

      this._sendSignal({ type: 'hello', peer_id: this._peerId })
      count++

      if (this._remotePeerId !== null) return  // peer found, stop

      if (count >= 30) {
        Logger.warning(
          `WebRtcConnection(${this._peerId}): no remote peer found — ` +
          'check that both peers use the same session_id.',
        )
        this._resolveConnect(false)
        return
      }

      this._helloTimer = setTimeout(tick, 1000)
    }

    tick()  // fire immediately, then every 1 s
  }

  // ---- Private: SDP negotiation -------------------------------------------

  private async _createOffer(): Promise<void> {
    const pc = this._pc!

    // Create the shared data channel (offerer side)
    const dcInit: RTCDataChannelInit = { ordered: this._opts.dataChannelOrdered }
    if (this._opts.dataChannelMaxRetransmits !== undefined) {
      dcInit.maxRetransmits = this._opts.dataChannelMaxRetransmits
    }
    const dc = pc.createDataChannel('magpie', dcInit)
    this._dataChannel = dc
    this._setupDataChannel(dc)

    // magpie-media unreliable DC only when useMediaChannels=true (RTP fallback).
    // When useMediaChannels=false, video/audio goes through the reliable magpie DC.
    if (this._opts.useMediaChannels) {
      const mediaDc = pc.createDataChannel('magpie-media', { ordered: false, maxRetransmits: 0 })
      this._mediaChannel = mediaDc
      this._setupMediaChannel(mediaDc)
    }

    // Add local media tracks or recvonly transceivers only if media channels enabled
    if (this._opts.useMediaChannels) {
      if (this._localVideoTrack) {
        pc.addTrack(this._localVideoTrack)
      } else {
        pc.addTransceiver('video', { direction: 'recvonly' })
      }
      if (this._localAudioTrack) {
        pc.addTrack(this._localAudioTrack)
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' })
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    this._sendSignal({ type: 'offer', peer_id: this._peerId, sdp: pc.localDescription!.sdp })
    Logger.debug(`WebRtcConnection(${this._peerId}): SDP offer sent.`)
  }

  // ---- Private: data channel ----------------------------------------------

  private _setupDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      Logger.debug(`WebRtcConnection(${this._peerId}): data channel open.`)
      // Resolve connect() here — mirrors Python: connect() only returns once
      // the data channel is ready to send, not just when ICE is established.
      this._resolveConnect(true)
    }

    // Answerer: ondatachannel may fire when the channel is already open,
    // in which case onopen never fires — handle it immediately.
    if (dc.readyState === 'open') {
      Logger.debug(`WebRtcConnection(${this._peerId}): data channel already open.`)
      this._resolveConnect(true)
    }

    dc.onclose = () => Logger.debug(`WebRtcConnection(${this._peerId}): data channel closed.`)

    dc.onmessage = (event) => {
      try {
        const raw = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data as Uint8Array
        const msg = this._serializer.deserialize(raw)
        this._routeDataMessage(msg)
      } catch (e) {
        Logger.warning(`WebRtcConnection(${this._peerId}): data channel message error: ${e}`)
      }
    }
  }

  private _setupMediaChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => Logger.debug(`WebRtcConnection(${this._peerId}): media channel open.`)
    dc.onclose = () => Logger.debug(`WebRtcConnection(${this._peerId}): media channel closed.`)
    dc.onmessage = (event) => {
      try {
        const raw = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data as Uint8Array
        const msg = this._serializer.deserialize(raw)
        this._routeMediaMessage(msg)
      } catch (e) {
        Logger.warning(`WebRtcConnection(${this._peerId}): media channel message error: ${e}`)
      }
    }
  }

  private _routeMediaMessage(msg: unknown): void {
    // magpie-media is the fallback path when useMediaChannels=true but RTP was
    // not fully negotiated (e.g. connecting to a C++ peer).  Subscribers that
    // registered for VIDEO_TOPIC / AUDIO_TOPIC via addVideoCallback /
    // addAudioCallback receive these frames.
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    const kind = m['kind'] as string | undefined
    const payload = m['payload']

    if ((kind !== 'video' && kind !== 'audio') || !payload || typeof payload !== 'object') return

    const topic = (m['topic'] as string | undefined) || kind
    const callbacks = kind === 'video' ? [...this._videoCallbacks] : [...this._audioCallbacks]
    for (const cb of callbacks) {
      try { cb(payload as Record<string, unknown>) } catch (e) {
        Logger.warning(`WebRtcConnection: media ${kind} callback error (topic='${topic}'): ${e}`)
      }
    }
  }

  private _routeDataMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    const msgType = m['type'] as string | undefined

    if (msgType === 'pub') {
      const topic = (m['topic'] as string | undefined) ?? ''
      const callbacks = this._pubCallbacks.get(topic)
      if (callbacks) {
        for (const cb of [...callbacks]) {
          try { cb(m['payload'], topic) } catch (e) {
            Logger.warning(`WebRtcConnection: pub callback error for '${topic}': ${e}`)
          }
        }
      }

    } else if (msgType === 'rpc_req') {
      const service = (m['service'] as string | undefined) ?? ''
      const cb = this._rpcServiceCallbacks.get(service)
      if (cb) {
        try { cb(msg) } catch (e) {
          Logger.warning(`WebRtcConnection: rpc_req callback error for '${service}': ${e}`)
        }
      } else {
        Logger.warning(`WebRtcConnection(${this._peerId}): no handler for service '${service}'`)
      }

    } else if (msgType === 'media') {
      // Video/audio frame routed via reliable data channel (useMediaChannels=false path)
      const topic = (m['topic'] as string | undefined) ?? ''
      const payload = m['payload']
      if (!topic || !payload || typeof payload !== 'object') return
      const callbacks = this._pubCallbacks.get(topic)
      if (callbacks) {
        for (const cb of [...callbacks]) {
          try { cb(payload, topic) } catch (e) {
            Logger.warning(`WebRtcConnection: media data callback error for '${topic}': ${e}`)
          }
        }
      }

    } else if (msgType === 'rpc_ack' || msgType === 'rpc_rep') {
      const rid = m['rid'] as string | undefined
      if (rid) {
        const cb = this._rpcReplyCallbacks.get(rid)
        if (cb) {
          try { cb(msg) } catch (e) {
            Logger.warning(`WebRtcConnection: rpc reply callback error for rid='${rid}': ${e}`)
          }
        }
      }
    }
  }

  // ---- Private: signaling -------------------------------------------------

  private _sendSignal(msg: unknown): void {
    try {
      this._signaler.publish(this._serializer.serialize(msg))
    } catch (e) {
      Logger.warning(`WebRtcConnection(${this._peerId}): signal send error: ${e}`)
    }
  }

  private _onSignalMessage(payloadBytes: Uint8Array): void {
    let msg: unknown
    try {
      msg = this._serializer.deserialize(payloadBytes)
    } catch (e) {
      Logger.warning(`WebRtcConnection(${this._peerId}): failed to deserialize signal: ${e}`)
      return
    }

    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (!('type' in m)) return
    if (m['peer_id'] === this._peerId) return  // ignore our own messages

    this._handleSignal(m).catch(e =>
      Logger.warning(`WebRtcConnection(${this._peerId}): signal handler error: ${e}`)
    )
  }

  private async _handleSignal(msg: Record<string, unknown>): Promise<void> {
    const msgType = msg['type'] as string
    const remotePeerId = (msg['peer_id'] as string | undefined) ?? ''

    // ---- hello: remote peer announces presence ----------------------------
    if (msgType === 'hello') {
      if (this._remotePeerId === null) {
        this._remotePeerId = remotePeerId
        Logger.debug(`WebRtcConnection(${this._peerId}): remote peer = ${remotePeerId}`)
      }

      if (!this._roleDecided) {
        this._roleDecided = true
        if (this._peerId > remotePeerId) {
          Logger.debug(`WebRtcConnection(${this._peerId}): role = offer`)
          await this._createOffer()
        } else {
          Logger.debug(`WebRtcConnection(${this._peerId}): role = answer`)
          // Reply immediately so the offerer can detect us even if it
          // subscribed after we stopped broadcasting hellos.
          this._sendSignal({ type: 'hello', peer_id: this._peerId })
        }
      }

    // ---- offer: remote peer sent SDP offer --------------------------------
    } else if (msgType === 'offer') {
      if (this._remotePeerId === null) this._remotePeerId = remotePeerId

      const sdp = (msg['sdp'] as string | undefined) ?? ''
      Logger.debug(`WebRtcConnection(${this._peerId}): received SDP offer.`)

      const pc = this._pc!
      // Add local tracks before setting remote description (only if media channels enabled)
      if (this._opts.useMediaChannels) {
        if (this._localVideoTrack) pc.addTrack(this._localVideoTrack)
        if (this._localAudioTrack) pc.addTrack(this._localAudioTrack)
      }

      await pc.setRemoteDescription({ sdp, type: 'offer' })
      await this._flushPendingIce()

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      this._sendSignal({ type: 'answer', peer_id: this._peerId, sdp: pc.localDescription!.sdp })
      Logger.debug(`WebRtcConnection(${this._peerId}): SDP answer sent.`)

    // ---- answer: remote peer sent SDP answer ------------------------------
    } else if (msgType === 'answer') {
      const sdp = (msg['sdp'] as string | undefined) ?? ''
      Logger.debug(`WebRtcConnection(${this._peerId}): received SDP answer.`)
      await this._pc!.setRemoteDescription({ sdp, type: 'answer' })
      await this._flushPendingIce()

    // ---- candidate: trickle ICE candidate ---------------------------------
    } else if (msgType === 'candidate') {
      const candidateStr = (msg['candidate'] as string | undefined) ?? ''
      if (!candidateStr) return

      const init: RTCIceCandidateInit = {
        candidate: candidateStr,
        sdpMid: msg['sdpMid'] as string | undefined,
        sdpMLineIndex: msg['sdpMLineIndex'] as number | undefined,
      }

      if (!this._pc!.remoteDescription) {
        this._pendingIceCandidates.push(init)
      } else {
        try {
          await this._pc!.addIceCandidate(init)
        } catch (e) {
          Logger.warning(`WebRtcConnection(${this._peerId}): ICE candidate error: ${e}`)
        }
      }
    }
  }

  private async _flushPendingIce(): Promise<void> {
    const candidates = this._pendingIceCandidates.splice(0)
    for (const c of candidates) {
      try {
        await this._pc!.addIceCandidate(c)
      } catch (e) {
        Logger.warning(`WebRtcConnection(${this._peerId}): buffered ICE candidate error: ${e}`)
      }
    }
  }

  // ---- Private: reconnect -------------------------------------------------

  private _reconnectAsync(): void {
    this._clearHelloTimer()

    if (this._pc) { this._pc.close(); this._pc = null }
    this._dataChannel = null
    this._mediaChannel = null
    this._videoNegotiated = false
    this._audioNegotiated = false
    this._remotePeerId = null
    this._roleDecided = false
    this._pendingIceCandidates = []
    this._connected = false
    this._pendingMediaSend = null
    this._mediaSendScheduled = false

    // New peer_id so both sides re-run role negotiation cleanly
    this._peerId = getUniqueId().slice(0, 12)
    Logger.debug(`WebRtcConnection: reconnecting with new peerId=${this._peerId}`)

    this._connectInner().catch(e =>
      Logger.warning(`WebRtcConnection: reconnect error: ${e}`)
    )
  }
}
