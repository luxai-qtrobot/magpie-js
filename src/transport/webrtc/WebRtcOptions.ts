/**
 * WebRTC transport options.
 * Mirrors Python's WebRTCOptions dataclass.
 */

export interface WebRtcTurnServer {
  /** TURN server URI, e.g. "turn:myturn.server:3478" */
  url: string
  username?: string
  credential?: string
}

export interface WebRtcOptions {
  // ---- ICE / NAT traversal --------------------------------------------------
  /** STUN server URIs. Defaults to Google's public STUN server. */
  stunServers?: string[]
  /** Optional TURN relay servers for strict NAT / corporate firewall scenarios. */
  turnServers?: WebRtcTurnServer[]
  /**
   * ICE candidate policy:
   * - "all"   — try direct, STUN-reflexive, and TURN relay candidates (default).
   * - "relay" — force TURN relay only.
   */
  iceTransportPolicy?: RTCIceTransportPolicy

  // ---- Data channel ---------------------------------------------------------
  /** Whether the data channel delivers messages in order (default true). */
  dataChannelOrdered?: boolean
  /** Maximum retransmit count for unreliable channels. Undefined = reliable. */
  dataChannelMaxRetransmits?: number

  /**
   * If true (default), use native WebRTC media tracks for video/audio when
   * the remote peer supports them.  If false, always use the data channel
   * fallback regardless of remote capabilities.
   */
  useMediaChannels?: boolean

  /**
   * JPEG quality (1–100) used to compress ImageFrameRaw frames before sending
   * over the data channel when useMediaChannels=false.
   * ImageFrameJpeg frames are forwarded as-is without re-encoding.
   * Default is 80.
   */
  mediaChannelJpegQuality?: number
}
