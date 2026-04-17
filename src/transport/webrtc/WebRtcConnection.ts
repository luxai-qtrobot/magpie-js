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
 *   message that includes their topic lists; the peer with the lexicographically
 *   higher peerId creates the offer using the union of both sides' topics.
 * - Each entry in videoTopics/audioTopics maps to one RTP transceiver (m-line).
 *   Both sides use the full union so m-line counts always match.
 * - Data channel routing uses the same wire envelope as Python:
 *     { type: "pub" | "rpc_req" | "rpc_ack" | "rpc_rep", ... }
 *
 * Media API
 * ---------
 * Sending (before connect()):
 *   conn.sendVideoTrack(track, topic)   // browser camera → remote peer on topic
 *   conn.sendAudioTrack(track, topic)   // browser mic    → remote peer on topic
 *
 * Receiving:
 *   const track = await conn.receiveVideoTrack(topic)   // Promise<MediaStreamTrack>
 *   const track = await conn.receiveAudioTrack(topic)   // Promise<MediaStreamTrack>
 *
 * Wire protocol is 100% compatible with Python's WebRTCConnection (0.8.8+).
 */

import { MsgpackSerializer } from '../../serializer/MsgpackSerializer'
import { Logger } from '../../utils/logger'
import { getUniqueId } from '../../utils/common'
import { MqttOptions } from '../mqtt/MqttOptions'
import { WebRtcOptions, WebRtcTurnServer } from './WebRtcOptions'
import { WebRtcSignaler, MqttSignaler } from './WebRtcSignaler'

type PubCallback = (payload: unknown, topic: string) => void
type RpcCallback = (msg: unknown) => void

/** Compute union: own topics + remote-only topics not already in own. */
function _unionTopics(own: string[], remote: string[]): string[] {
  const seen = new Set(own)
  return [...own, ...remote.filter(t => !seen.has(t))]
}


export class WebRtcConnection {
  // ---- Identity -----------------------------------------------------------
  readonly sessionId: string
  private _peerId: string

  // ---- Config -------------------------------------------------------------
  private readonly _signaler: WebRtcSignaler
  private readonly _reconnect: boolean
  private readonly _opts: {
    stunServers: string[]
    turnServers: WebRtcTurnServer[]
    iceTransportPolicy: RTCIceTransportPolicy
    dataChannelOrdered: boolean
    dataChannelMaxRetransmits?: number
    useMediaChannels: boolean
    mediaChannelJpegQuality: number
  }
  private readonly _serializer = new MsgpackSerializer()

  // ---- WebRTC objects -----------------------------------------------------
  private _pc: RTCPeerConnection | null = null
  private _dataChannel: RTCDataChannel | null = null
  private _mediaChannel: RTCDataChannel | null = null

  // ---- Drop-stale media send (useMediaChannels=false path) ----------------
  private _pendingMediaSend: Uint8Array | null = null
  private _mediaSendScheduled = false

  // ---- Own topic lists (mutable — updated by sendVideoTrack/receiveVideoTrack) ----
  private _videoTopics: string[]
  private _audioTopics: string[]

  // ---- Local tracks to send (topic → track, set before connect()) ---------
  private _localVideoTracks = new Map<string, MediaStreamTrack>()
  private _localAudioTracks = new Map<string, MediaStreamTrack>()

  // ---- Remote peer's topics (from hello / offer) --------------------------
  private _remoteVideoTopics: string[] = []
  private _remoteAudioTopics: string[] = []

  // ---- Union topics used for this negotiation (audio-first, then video) ---
  private _unionVideoTopics: string[] = []
  private _unionAudioTopics: string[] = []

  // ---- ontrack index counters (reset on each connection) ------------------
  private _videoTrackIdx = 0
  private _audioTrackIdx = 0

  // ---- Received remote tracks (topic → track, for late subscribers) -------
  private _receivedVideoTracks = new Map<string, MediaStreamTrack>()
  private _receivedAudioTracks = new Map<string, MediaStreamTrack>()

  // ---- Pending receiveVideoTrack / receiveAudioTrack promises -------------
  private _videoTrackWaiters = new Map<string, Array<(track: MediaStreamTrack) => void>>()
  private _audioTrackWaiters = new Map<string, Array<(track: MediaStreamTrack) => void>>()

  // ---- Negotiated state (per topic) ---------------------------------------
  private _videoNegotiated = new Set<string>()
  private _audioNegotiated = new Set<string>()

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

  // ---- Data-channel message routing ---------------------------------------
  private _pubCallbacks = new Map<string, Set<PubCallback>>()
  private _rpcServiceCallbacks = new Map<string, RpcCallback>()
  private _rpcReplyCallbacks = new Map<string, RpcCallback>()

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
      stunServers:              o.stunServers ?? ['stun:stun.l.google.com:19302'],
      turnServers:              o.turnServers ?? [],
      iceTransportPolicy:       o.iceTransportPolicy ?? 'all',
      dataChannelOrdered:       o.dataChannelOrdered ?? true,
      dataChannelMaxRetransmits: o.dataChannelMaxRetransmits,
      useMediaChannels:         o.useMediaChannels ?? true,
      mediaChannelJpegQuality:  o.mediaChannelJpegQuality ?? 80,
    }
    this._videoTopics = [...(o.videoTopics ?? [])]
    this._audioTopics = [...(o.audioTopics ?? [])]

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
   *     'wss://broker.hivemq.com:8884/mqtt', 'my-robot',
   *     { webrtcOptions: { videoTopics: ['/camera/color/image'] } }
   *   )
   *   await conn.connect(30)
   *   const track = await conn.receiveVideoTrack('/camera/color/image')
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
  /** Whether native WebRTC media tracks are used for video/audio (vs data channel). */
  get useMediaChannels(): boolean { return this._opts.useMediaChannels }
  /** JPEG quality (1–100) used when compressing frames sent over the data channel. */
  get mediaChannelJpegQuality(): number { return this._opts.mediaChannelJpegQuality }
  /** Own video topic paths (declared in options or via sendVideoTrack/receiveVideoTrack). */
  get videoTopics(): readonly string[] { return this._videoTopics }
  /** Own audio topic paths (declared in options or via sendAudioTrack/receiveAudioTrack). */
  get audioTopics(): readonly string[] { return this._audioTopics }

  /** True if the RTP video track for this topic was negotiated with the remote peer. */
  isVideoNegotiated(topic: string): boolean { return this._videoNegotiated.has(topic) }
  /** True if the RTP audio track for this topic was negotiated with the remote peer. */
  isAudioNegotiated(topic: string): boolean { return this._audioNegotiated.has(topic) }

  // ---- Media send API (call before connect()) -----------------------------

  /**
   * Register a local video track to send to the remote peer on the given topic.
   * Obtain a track from getUserMedia() or HTMLCanvasElement.captureStream().
   * Must be called before connect().
   *
   * @param track  Native browser MediaStreamTrack (kind = 'video').
   * @param topic  The topic path this track is published on (e.g. '/camera/color/image').
   */
  sendVideoTrack(track: MediaStreamTrack, topic: string): void {
    if (!this._videoTopics.includes(topic)) this._videoTopics.push(topic)
    this._localVideoTracks.set(topic, track)
    Logger.debug(`WebRtcConnection: sendVideoTrack registered for '${topic}'`)
  }

  /**
   * Register a local audio track to send to the remote peer on the given topic.
   * Must be called before connect().
   *
   * @param track  Native browser MediaStreamTrack (kind = 'audio').
   * @param topic  The topic path this track is published on (e.g. '/mic/audio/stream').
   */
  sendAudioTrack(track: MediaStreamTrack, topic: string): void {
    if (!this._audioTopics.includes(topic)) this._audioTopics.push(topic)
    this._localAudioTracks.set(topic, track)
    Logger.debug(`WebRtcConnection: sendAudioTrack registered for '${topic}'`)
  }

  // ---- Media receive API --------------------------------------------------

  /**
   * Return a Promise that resolves with the remote MediaStreamTrack for the
   * given video topic once it arrives (or immediately if already received).
   *
   * Calling this before connect() also registers the topic for SDP negotiation
   * (equivalent to including it in WebRtcOptions.videoTopics).
   *
   * Attach the resolved track to a <video> element:
   *   const track = await conn.receiveVideoTrack('/camera/color/image')
   *   videoEl.srcObject = new MediaStream([track])
   */
  receiveVideoTrack(topic: string): Promise<MediaStreamTrack> {
    if (!this._videoTopics.includes(topic)) this._videoTopics.push(topic)
    const existing = this._receivedVideoTracks.get(topic)
    if (existing) return Promise.resolve(existing)
    return new Promise<MediaStreamTrack>((resolve) => {
      if (!this._videoTrackWaiters.has(topic)) this._videoTrackWaiters.set(topic, [])
      this._videoTrackWaiters.get(topic)!.push(resolve)
    })
  }

  /**
   * Return a Promise that resolves with the remote MediaStreamTrack for the
   * given audio topic once it arrives (or immediately if already received).
   *
   * Attach the resolved track to an <audio> element:
   *   const track = await conn.receiveAudioTrack('/mic/audio/stream')
   *   audioEl.srcObject = new MediaStream([track])
   */
  receiveAudioTrack(topic: string): Promise<MediaStreamTrack> {
    if (!this._audioTopics.includes(topic)) this._audioTopics.push(topic)
    const existing = this._receivedAudioTracks.get(topic)
    if (existing) return Promise.resolve(existing)
    return new Promise<MediaStreamTrack>((resolve) => {
      if (!this._audioTrackWaiters.has(topic)) this._audioTrackWaiters.set(topic, [])
      this._audioTrackWaiters.get(topic)!.push(resolve)
    })
  }

  // ---- Connection lifecycle -----------------------------------------------

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
   * Enqueue a pre-serialized media frame for drop-stale sending via the reliable
   * data channel. Used when useMediaChannels=false.
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
    for (const turn of this._opts.turnServers) {
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
        // Mark all union topics as negotiated (mirrors Python's on_connectionstatechange)
        for (const t of this._unionVideoTopics) this._videoNegotiated.add(t)
        for (const t of this._unionAudioTopics) this._audioNegotiated.add(t)
        // _resolveConnect(true) is called from _setupDataChannel's onopen
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
        this._mediaChannel = event.channel
        this._setupMediaChannel(event.channel)
      }
    }

    // ontrack fires in m-line order: audio topics first (in union order), then video topics.
    // Index counters map each event to the correct topic.
    pc.ontrack = (event) => {
      const track = event.track
      if (track.kind === 'video') {
        const topic = this._unionVideoTopics[this._videoTrackIdx++]
        if (!topic) {
          Logger.warning(`WebRtcConnection(${this._peerId}): unexpected video track (idx=${this._videoTrackIdx - 1})`)
          return
        }
        Logger.debug(`WebRtcConnection(${this._peerId}): video track arrived for '${topic}'`)
        this._receivedVideoTracks.set(topic, track)
        const waiters = this._videoTrackWaiters.get(topic) ?? []
        this._videoTrackWaiters.delete(topic)
        for (const resolve of waiters) {
          try { resolve(track) } catch (_) { /* ignore */ }
        }
      } else if (track.kind === 'audio') {
        const topic = this._unionAudioTopics[this._audioTrackIdx++]
        if (!topic) {
          Logger.warning(`WebRtcConnection(${this._peerId}): unexpected audio track (idx=${this._audioTrackIdx - 1})`)
          return
        }
        Logger.debug(`WebRtcConnection(${this._peerId}): audio track arrived for '${topic}'`)
        this._receivedAudioTracks.set(topic, track)
        const waiters = this._audioTrackWaiters.get(topic) ?? []
        this._audioTrackWaiters.delete(topic)
        for (const resolve of waiters) {
          try { resolve(track) } catch (_) { /* ignore */ }
        }
      }
    }
  }

  // ---- Private: hello loop ------------------------------------------------

  private _startHelloLoop(): void {
    let count = 0

    const tick = () => {
      if (this._closing) return

      this._sendSignal({
        type: 'hello',
        peer_id: this._peerId,
        video_topics: this._videoTopics,
        audio_topics: this._audioTopics,
      })
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

    if (this._opts.useMediaChannels) {
      const mediaDc = pc.createDataChannel('magpie-media', { ordered: false, maxRetransmits: 0 })
      this._mediaChannel = mediaDc
      this._setupMediaChannel(mediaDc)
    }

    // Compute union: own topics + remote-only topics not already in own
    const unionAudio = _unionTopics(this._audioTopics, this._remoteAudioTopics)
    const unionVideo = _unionTopics(this._videoTopics, this._remoteVideoTopics)
    this._unionAudioTopics = unionAudio
    this._unionVideoTopics = unionVideo

    // Add transceivers: audio topics first (in union order), then video.
    // This order must match what the answerer expects for index-based ontrack mapping.
    if (this._opts.useMediaChannels) {
      for (const topic of unionAudio) {
        const track = this._localAudioTracks.get(topic)
        if (track) {
          pc.addTrack(track)
        } else {
          pc.addTransceiver('audio', { direction: 'recvonly' })
        }
      }
      for (const topic of unionVideo) {
        const track = this._localVideoTracks.get(topic)
        if (track) {
          pc.addTrack(track)
        } else {
          pc.addTransceiver('video', { direction: 'recvonly' })
        }
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    this._sendSignal({
      type: 'offer',
      peer_id: this._peerId,
      sdp: pc.localDescription!.sdp,
      audio_topics: unionAudio,
      video_topics: unionVideo,
    })
    Logger.debug(`WebRtcConnection(${this._peerId}): SDP offer sent (audio=${unionAudio.length}, video=${unionVideo.length}).`)
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

  // magpie-media fallback: route to pub callbacks by topic so WebRtcSubscriber
  // handles these frames the same way as data-channel frames.
  private _routeMediaMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    const kind = m['kind'] as string | undefined
    const payload = m['payload']
    const topic = (m['topic'] as string | undefined) ?? ''

    if ((kind !== 'video' && kind !== 'audio') || !payload || typeof payload !== 'object' || !topic) return

    const callbacks = this._pubCallbacks.get(topic)
    if (callbacks) {
      for (const cb of [...callbacks]) {
        try { cb(payload, topic) } catch (e) {
          Logger.warning(`WebRtcConnection: media channel callback error for '${topic}': ${e}`)
        }
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
      // Video/audio frame routed via reliable data channel (useMediaChannels=false path).
      // Route to pub callbacks by topic — same as regular pub messages.
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

    // ---- hello: remote peer announces presence with topic lists ---------------
    if (msgType === 'hello') {
      const remoteVideoTopics = (msg['video_topics'] as string[] | undefined) ?? []
      const remoteAudioTopics = (msg['audio_topics'] as string[] | undefined) ?? []

      if (this._remotePeerId === null) {
        this._remotePeerId = remotePeerId
        Logger.debug(`WebRtcConnection(${this._peerId}): remote peer = ${remotePeerId}`)
      }
      // Always update remote topics (they may arrive before role decision)
      this._remoteVideoTopics = remoteVideoTopics
      this._remoteAudioTopics = remoteAudioTopics

      if (!this._roleDecided) {
        this._roleDecided = true
        if (this._peerId > remotePeerId) {
          Logger.debug(`WebRtcConnection(${this._peerId}): role = offer`)
          await this._createOffer()
        } else {
          Logger.debug(`WebRtcConnection(${this._peerId}): role = answer`)
          // Reply immediately so the offerer can detect us even if it
          // subscribed after we stopped broadcasting hellos.
          this._sendSignal({
            type: 'hello',
            peer_id: this._peerId,
            video_topics: this._videoTopics,
            audio_topics: this._audioTopics,
          })
        }
      }

    // ---- offer: remote peer sent SDP offer with topic lists ------------------
    } else if (msgType === 'offer') {
      if (this._remotePeerId === null) this._remotePeerId = remotePeerId

      const sdp = (msg['sdp'] as string | undefined) ?? ''
      const offerAudioTopics = (msg['audio_topics'] as string[] | undefined) ?? []
      const offerVideoTopics = (msg['video_topics'] as string[] | undefined) ?? []

      Logger.debug(`WebRtcConnection(${this._peerId}): received SDP offer (audio=${offerAudioTopics.length}, video=${offerVideoTopics.length}).`)

      this._remoteAudioTopics = offerAudioTopics
      this._remoteVideoTopics = offerVideoTopics

      // Compute union for ontrack index mapping
      const unionAudio = _unionTopics(this._audioTopics, offerAudioTopics)
      const unionVideo = _unionTopics(this._videoTopics, offerVideoTopics)
      this._unionAudioTopics = unionAudio
      this._unionVideoTopics = unionVideo

      const pc = this._pc!

      // Add local tracks BEFORE setRemoteDescription so the browser
      // matches them to the offer's m-lines. Only add for topics where
      // we have a local track — answerer does not call addTransceiver
      // (the offer's m-lines already define the transceivers).
      if (this._opts.useMediaChannels) {
        for (const topic of unionAudio) {
          const track = this._localAudioTracks.get(topic)
          if (track) pc.addTrack(track)
        }
        for (const topic of unionVideo) {
          const track = this._localVideoTracks.get(topic)
          if (track) pc.addTrack(track)
        }
      }

      await pc.setRemoteDescription({ sdp, type: 'offer' })
      await this._flushPendingIce()

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      this._sendSignal({
        type: 'answer',
        peer_id: this._peerId,
        sdp: pc.localDescription!.sdp,
        audio_topics: unionAudio,
        video_topics: unionVideo,
      })
      Logger.debug(`WebRtcConnection(${this._peerId}): SDP answer sent.`)

    // ---- answer: remote peer sent SDP answer ---------------------------------
    } else if (msgType === 'answer') {
      const sdp = (msg['sdp'] as string | undefined) ?? ''
      Logger.debug(`WebRtcConnection(${this._peerId}): received SDP answer.`)
      await this._pc!.setRemoteDescription({ sdp, type: 'answer' })
      await this._flushPendingIce()

    // ---- candidate: trickle ICE candidate ------------------------------------
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

    // Reset per-negotiation state — preserve local tracks, topic lists, and
    // pending receiveVideoTrack/receiveAudioTrack waiters across reconnection.
    this._videoNegotiated.clear()
    this._audioNegotiated.clear()
    this._receivedVideoTracks.clear()
    this._receivedAudioTracks.clear()
    this._unionVideoTopics = []
    this._unionAudioTopics = []
    this._remoteVideoTopics = []
    this._remoteAudioTopics = []
    this._videoTrackIdx = 0
    this._audioTrackIdx = 0
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
