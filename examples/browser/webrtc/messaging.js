/* global Magpie */
const { WebRtcConnection, WebRtcStreamWriter, WebRtcStreamReader,
        WebRtcRpcRequester, WebRtcRpcResponder, AckTimeoutError, ReplyTimeoutError } = Magpie

let conn       = null
let writer     = null
let reader     = null
let requester  = null
let responder  = null
let subActive  = false
let respActive = false

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

function appendLog(logId, topic, data, isErr = false) {
  const log = document.getElementById(logId)
  if (!log.querySelector('.entry')) log.innerHTML = ''
  const entry = document.createElement('div')
  entry.className = 'entry'
  entry.innerHTML =
    `<span class="ts">${ts()}</span>` +
    (topic ? `<span class="topic">${topic}</span>` : '') +
    `<span class="${isErr ? 'err' : 'data'}">${data}</span>`
  log.appendChild(entry)
  log.scrollTop = log.scrollHeight
}

function parsePayload(raw) {
  try { return JSON.parse(raw) } catch { return raw }
}

function setStatus(state) {
  const dot  = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  const btn  = document.getElementById('btn-connect')
  const interactive = ['btn-publish', 'btn-subscribe', 'btn-request', 'btn-responder']

  dot.className  = state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : ''
  text.textContent = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' }[state]
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

  setStatus('connecting')
  document.getElementById('status-text').textContent = 'Connecting to broker…'

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

  document.getElementById('status-text').textContent = 'Waiting for peer…'

  const ok = await conn.connect(60)

  if (!ok) {
    alert('WebRTC connection failed or timed out.\nMake sure the remote peer is running with the same session ID.')
    await conn.disconnect()
    conn = null
    setStatus('disconnected')
    return
  }

  writer = new WebRtcStreamWriter(conn)
  setStatus('connected')
}

async function cleanup() {
  if (subActive)  { reader?.close(); reader = null; subActive  = false }
  if (respActive) { responder?.close();  responder  = null; respActive = false }
  requester?.close(); requester = null
  writer?.close(); writer = null
  if (conn) { await conn.disconnect(); conn = null }
  setStatus('disconnected')
  document.getElementById('btn-subscribe').textContent = 'Subscribe'
  document.getElementById('btn-subscribe').className   = 'success'
  document.getElementById('btn-responder').textContent = 'Start Responder'
  document.getElementById('btn-responder').className   = 'success'
}

// ── Publish ───────────────────────────────────────────────────────────────────

async function doPublish() {
  const topic = document.getElementById('pub-topic').value.trim()
  const raw   = document.getElementById('pub-msg').value.trim()
  if (!topic) return
  await writer.write(parsePayload(raw), topic)
  appendLog('sub-log', null, `✓ published to '${topic}': ${raw}`)
}

// ── Subscribe ─────────────────────────────────────────────────────────────────

function toggleSubscribe() {
  if (subActive) {
    reader?.close(); reader = null; subActive = false
    document.getElementById('btn-subscribe').textContent = 'Subscribe'
    document.getElementById('btn-subscribe').className   = 'success'
    return
  }
  const topic = document.getElementById('sub-topic').value.trim()
  if (!topic) return

  reader = new WebRtcStreamReader(conn, topic)
  subActive  = true
  document.getElementById('btn-subscribe').textContent = 'Unsubscribe'
  document.getElementById('btn-subscribe').className   = 'danger'
  document.getElementById('sub-log').innerHTML = ''
  subReadLoop()
}

async function subReadLoop() {
  while (subActive && reader) {
    try {
      const [data, topic] = await reader.read(3.0)
      appendLog('sub-log', topic, JSON.stringify(data))
    } catch (err) {
      if (!subActive) break
      if (err.name === 'TimeoutError') continue
      appendLog('sub-log', null, `error: ${err.message}`, true)
      break
    }
  }
}

// ── RPC Request ───────────────────────────────────────────────────────────────

async function doRequest() {
  const service = document.getElementById('req-service').value.trim()
  const raw     = document.getElementById('req-payload').value.trim()
  const box     = document.getElementById('req-response')
  if (!service) return

  if (!requester || requester._serviceName !== service) {
    requester?.close()
    requester = new WebRtcRpcRequester(conn, service)
  }

  box.className   = 'response-box waiting'
  box.textContent = '⏳ waiting…'
  document.getElementById('btn-request').disabled = true

  try {
    const response = await requester.call(parsePayload(raw), 5.0)
    box.className   = 'response-box'
    box.textContent = JSON.stringify(response, null, 2)
  } catch (err) {
    box.className   = 'response-box err'
    box.textContent = `${err.name}: ${err.message}`
  } finally {
    document.getElementById('btn-request').disabled = false
  }
}

// ── RPC Responder ─────────────────────────────────────────────────────────────

function toggleResponder() {
  if (respActive) {
    responder?.close(); responder = null; respActive = false
    document.getElementById('btn-responder').textContent = 'Start Responder'
    document.getElementById('btn-responder').className   = 'success'
    return
  }
  const service = document.getElementById('resp-service').value.trim()
  if (!service) return

  responder  = new WebRtcRpcResponder(conn, service)
  respActive = true
  document.getElementById('btn-responder').textContent = 'Stop Responder'
  document.getElementById('btn-responder').className   = 'danger'
  document.getElementById('resp-log').innerHTML = ''

  responder.onRequest((request) => {
    appendLog('resp-log', null, `← ${JSON.stringify(request)}`)
    const response = { status: 'ok', echo: request }
    appendLog('resp-log', null, `→ ${JSON.stringify(response)}`)
    return response
  })
}
