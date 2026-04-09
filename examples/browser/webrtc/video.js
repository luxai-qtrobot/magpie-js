/* global Magpie */
const { WebRtcConnection, WebRtcSubscriber } = Magpie

let conn        = null
let videoSub    = null
let audioSub    = null
let dataSub     = null
let dataActive  = false
let muted       = true
let audioTrack  = null
let audioEl     = null   // dedicated Audio element, avoids stalled-video-track issue

const videoEl = () => document.getElementById('video-el')

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

function appendLog(logId, text, isErr = false) {
  const log = document.getElementById(logId)
  if (!log.querySelector('.entry')) log.innerHTML = ''
  const entry = document.createElement('div')
  entry.className = 'entry'
  entry.innerHTML =
    `<span class="ts">${ts()}</span>` +
    `<span class="${isErr ? 'err' : 'data'}">${text}</span>`
  log.appendChild(entry)
  log.scrollTop = log.scrollHeight
}

function setStatus(state, detail) {
  const dot  = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  const btn  = document.getElementById('btn-connect')
  const interactive = ['btn-unmute', 'btn-fullscreen', 'btn-subscribe']

  dot.className = state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : ''
  text.textContent = detail ?? { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' }[state]
  btn.textContent  = state === 'connected' ? 'Disconnect' : 'Connect'
  btn.className    = state === 'connected' ? 'danger' : 'primary'
  btn.disabled     = state === 'connecting'
  interactive.forEach(id => document.getElementById(id).disabled = state !== 'connected')
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

async function toggleConnect() {
  if (conn) { await cleanup(); return }

  const broker    = document.getElementById('broker-uri').value.trim()
  const sessionId = document.getElementById('session-id').value.trim()
  const noStun    = document.getElementById('no-stun').checked

  if (!broker || !sessionId) { alert('Please enter broker URL and session ID.'); return }

  setStatus('connecting', 'Connecting to broker…')

  try {
    conn = await WebRtcConnection.withMqtt(broker, sessionId, {
      reconnect: true,
      webrtcOptions: noStun ? { stunServers: [] } : undefined,
    })
  } catch (err) {
    alert(`Broker connection failed: ${err.message}`)
    conn = null
    setStatus('disconnected')
    return
  }

  // Set up subscribers before connect() so we don't miss early tracks
  videoSub = new WebRtcSubscriber(conn, WebRtcSubscriber.VIDEO_TOPIC)
  audioSub = new WebRtcSubscriber(conn, WebRtcSubscriber.AUDIO_TOPIC)

  setStatus('connecting', 'Waiting for peer…')
  const ok = await conn.connect(60)

  if (!ok) {
    alert(
      'WebRTC connection failed or timed out.\n' +
      'Make sure the Python peer is running with the same session ID.\n\n' +
      'Tip: add --webrtc-options \'{"stun_servers":[]}\' on the Python side for local testing.',
    )
    await cleanup()
    return
  }

  setStatus('connected')

  // Wait for video and audio tracks asynchronously
  waitForVideo()
  waitForAudio()
}

async function cleanup() {
  if (dataActive)  { dataSub?.close(); dataSub = null; dataActive = false }
  videoSub?.close(); videoSub = null
  audioSub?.close(); audioSub = null
  if (conn) { await conn.disconnect(); conn = null }

  // Reset video
  const v = videoEl()
  v.srcObject = null
  audioTrack  = null
  muted       = true
  v.muted     = true
  if (audioEl) { audioEl.pause(); audioEl.srcObject = null; audioEl = null }

  document.getElementById('video-placeholder').classList.remove('hidden')
  document.getElementById('video-badge').style.display  = 'none'
  document.getElementById('res-badge').style.display    = 'none'
  document.getElementById('btn-unmute').textContent     = '🔊 Unmute Audio'
  document.getElementById('btn-unmute').className       = 'success'
  document.getElementById('btn-subscribe').textContent  = 'Subscribe'
  document.getElementById('btn-subscribe').className    = 'success'

  setStatus('disconnected')
}

// ── Video track ───────────────────────────────────────────────────────────────

async function waitForVideo() {
  try {
    const [track] = await videoSub.read(60)       // wait up to 60 s
    const v = videoEl()
    v.srcObject = new MediaStream([track])

    v.onloadedmetadata = () => {
      document.getElementById('video-placeholder').classList.add('hidden')
      document.getElementById('video-badge').style.display = 'inline'
      updateResBadge(v)
    }

    v.onresize = () => updateResBadge(v)

    await v.play().catch(() => {
      // Autoplay blocked — user must interact first; unmute button will trigger play
    })
  } catch {
    // Subscriber closed or connection dropped — no video track received
  }
}

function updateResBadge(v) {
  const badge = document.getElementById('res-badge')
  if (v.videoWidth && v.videoHeight) {
    badge.textContent    = `${v.videoWidth}×${v.videoHeight}`
    badge.style.display  = 'inline'
  }
}

// ── Audio track ───────────────────────────────────────────────────────────────

async function waitForAudio() {
  try {
    console.log('[audio] waitForAudio: waiting for audio track...')
    const [track] = await audioSub.read(60)
    audioTrack = track
    console.log('[audio] track received — kind:', track.kind, 'readyState:', track.readyState, 'enabled:', track.enabled, 'muted:', track.muted)
    appendLog('audio-log', `Audio track received (readyState=${track.readyState}, muted=${track.muted}) — click Unmute to hear it.`)

    // Monitor RTP lifecycle — muted=true means no RTP yet; unmute fires when data arrives
    track.onunmute = () => {
      console.log('[audio] track UNMUTED — RTP is now flowing!')
      appendLog('audio-log', 'Audio RTP flowing (track unmuted).')
    }
    track.onmute = () => {
      console.log('[audio] track MUTED — RTP stopped.')
      appendLog('audio-log', 'Audio RTP stopped (track muted).', true)
    }
    track.onended = () => {
      console.log('[audio] track ENDED.')
      appendLog('audio-log', 'Audio track ended.', true)
    }

    // Use a dedicated <audio> element so a stalled/empty video track
    // cannot block audio playback (Chrome stalls <video> when video track has no RTP)
    audioEl = new Audio()
    audioEl.srcObject = new MediaStream([track])
    audioEl.muted = true   // start muted; user clicks Unmute to hear it
    console.log('[audio] starting dedicated audio element...')
    await audioEl.play().catch((e) => console.warn('[audio] audioEl.play() rejected:', e))
    console.log('[audio] audioEl playing — paused:', audioEl.paused, 'muted:', audioEl.muted)
  } catch (e) {
    console.error('[audio] waitForAudio error:', e)
    appendLog('audio-log', `Audio error: ${e?.message ?? e}`, true)
  }
}

function toggleMute() {
  const v   = videoEl()
  const btn = document.getElementById('btn-unmute')
  muted = !muted
  v.muted = muted
  console.log('[audio] toggleMute: muted=', muted, 'v.srcObject tracks:', v.srcObject?.getTracks().map(t => `${t.kind}(${t.readyState})`))
  if (!muted) {
    // Unmute the dedicated audio element (user gesture satisfies autoplay policy)
    if (audioEl) {
      audioEl.muted = false
      audioEl.play().catch((e) => console.warn('[audio] audioEl.play() after unmute rejected:', e))
    }
    v.play().catch((e) => console.warn('[audio] play() after unmute rejected:', e))
    btn.textContent = '🔇 Mute Audio'
    btn.className   = 'danger'
    appendLog('audio-log', 'Audio unmuted.')
  } else {
    if (audioEl) audioEl.muted = true
    btn.textContent = '🔊 Unmute Audio'
    btn.className   = 'success'
  }
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

function goFullscreen() {
  const v = videoEl()
  if (v.requestFullscreen) v.requestFullscreen()
}

// ── Data channel subscribe ────────────────────────────────────────────────────

function toggleSubscribe() {
  if (dataActive) {
    dataSub?.close(); dataSub = null; dataActive = false
    document.getElementById('btn-subscribe').textContent = 'Subscribe'
    document.getElementById('btn-subscribe').className   = 'success'
    return
  }
  const topic = document.getElementById('data-topic').value.trim()
  if (!topic) return

  dataSub    = new WebRtcSubscriber(conn, topic)
  dataActive = true
  document.getElementById('btn-subscribe').textContent = 'Unsubscribe'
  document.getElementById('btn-subscribe').className   = 'danger'
  document.getElementById('data-log').innerHTML = ''
  dataReadLoop()
}

async function dataReadLoop() {
  while (dataActive && dataSub) {
    try {
      const [data, topic] = await dataSub.read(3.0)
      appendLog('data-log', `[${topic}] ${JSON.stringify(data)}`)
    } catch (err) {
      if (!dataActive) break
      if (err.name === 'TimeoutError') continue
      appendLog('data-log', `error: ${err.message}`, true)
      break
    }
  }
}
