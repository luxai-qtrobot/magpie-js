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
}
