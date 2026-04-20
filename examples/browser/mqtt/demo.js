/* global Magpie */
const { MqttConnection, MqttStreamWriter, MqttStreamReader,
        MqttRpcRequester, MqttRpcResponder, TimeoutError } = Magpie

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
  if (!log.querySelector('.entry')) log.innerHTML = ''   // clear placeholder only
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

function setConnected(yes) {
  document.getElementById('status-dot').className   = yes ? 'connected' : ''
  document.getElementById('status-text').textContent = yes ? 'Connected' : 'Disconnected'
  document.getElementById('btn-connect').textContent = yes ? 'Disconnect' : 'Connect'
  document.getElementById('btn-connect').className   = yes ? 'danger' : 'primary'
  ;['btn-publish', 'btn-subscribe', 'btn-request', 'btn-responder']
    .forEach(id => document.getElementById(id).disabled = !yes)
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

async function toggleConnect() {
  if (conn && conn.isConnected) {
    await cleanup()
    return
  }
  const uri = document.getElementById('broker-uri').value.trim()
  document.getElementById('btn-connect').disabled    = true
  document.getElementById('btn-connect').textContent = 'Connecting…'
  try {
    conn = new MqttConnection(uri)
    await conn.connect(10_000)
    publisher = new MqttStreamWriter(conn)
    setConnected(true)
  } catch (err) {
    alert(`Connection failed: ${err.message}`)
    conn = null
  } finally {
    document.getElementById('btn-connect').disabled = false
  }
}

async function cleanup() {
  if (reader)     { reader.close();     reader     = null; subActive  = false }
  if (requester)  { requester.close();  requester  = null }
  if (responder)  { responder.close();  responder  = null; respActive = false }
  if (writer)     { writer.close();     writer     = null }
  if (conn)       { await conn.disconnect(); conn   = null }
  setConnected(false)
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
    reader.close()
    reader = null
    subActive  = false
    document.getElementById('btn-subscribe').textContent = 'Subscribe'
    document.getElementById('btn-subscribe').className   = 'success'
    return
  }
  const topic = document.getElementById('sub-topic').value.trim()
  if (!topic) return
  subscriber = new MqttStreamReader(conn, { topic })
  subActive  = true
  document.getElementById('btn-subscribe').textContent = 'Unsubscribe'
  document.getElementById('btn-subscribe').className   = 'danger'
  document.getElementById('sub-log').innerHTML = ''
  readLoop()
}

async function readLoop() {
  while (subActive && reader) {
    try {
      const [data, topic] = await reader.read(3.0)
      appendLog('sub-log', topic, JSON.stringify(data))
    } catch (err) {
      if (!subActive) break
      if (err instanceof TimeoutError) continue
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

  // Recreate requester if service changed
  if (!requester || requester._reqTopic !== `${service}/rpc/req`) {
    if (requester) requester.close()
    requester = new MqttRpcRequester(conn, service)
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
    responder.close()
    responder  = null
    respActive = false
    document.getElementById('btn-responder').textContent = 'Start Responder'
    document.getElementById('btn-responder').className   = 'success'
    return
  }
  const service = document.getElementById('resp-service').value.trim()
  if (!service) return

  responder  = new MqttRpcResponder(conn, service)
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
