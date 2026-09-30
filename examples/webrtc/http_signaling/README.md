# Copyable Node HTTP signaling relay

`relay.cjs` uses Node built-ins and does not import MAGPIE. Copy it into an
existing web application. `InMemoryRelay` holds the participant mailboxes,
`SignalingHTTP` implements the HTTP protocol, and `createNodeHandler` adapts it
to Node's request/response API (including an Express mount):

```js
const { InMemoryRelay, SignalingHTTP, createNodeHandler } = require('./relay.cjs')
app.use('/webrtc', createNodeHandler(new SignalingHTTP(new InMemoryRelay()), {
  prefix: '/webrtc',
}))
```

Clients then use `WebRtcConnection.withHttp('https://host/webrtc', sessionId)`.
Authentication and CORS belong in the hosting application; mount their
middleware before the relay handler. The runnable Express example is
[`../http_signaling_server.cjs`](../http_signaling_server.cjs) and needs only
`express` and `cors`. No HTTP server package is a MAGPIE dependency.

The wire contract matches Python MAGPIE's HTTP signaling relay:

| Request | Meaning |
| --- | --- |
| `PUT /sessions/{session}/peers/{peer}` | Join or renew; optional opaque body caches a hello for later peers |
| `POST /sessions/{session}/peers/{peer}/messages` | Forward opaque bytes to the other peers; include `X-Magpie-Message-Id` |
| `GET /sessions/{session}/peers/{peer}/messages?after=N&wait=S` | Long-poll, returning bytes and `X-Magpie-Sequence` |
| `DELETE /sessions/{session}/peers/{peer}` | Leave |

The client prepends its configured base URL and encodes each ID as unpadded
URL-safe Base64 of UTF-8. POST bodies and GET response bodies are opaque bytes.
The relay preserves each recipient's message order, suppresses repeated POSTs
with the same message ID, and replays a message until the GET cursor advances.
The relay atomically sends a new participant's cached hello to existing peers
and replays their cached hellos to the newcomer. Its PUT response advertises
`X-Magpie-Join-Announcements: 1`. With a relay that lacks this header, the
client repeats its initial hello by POST for discovery. Long-poll GETs keep
the registration alive; mailboxes expire after 90 seconds without activity.
The helper is single-process and in-memory; scaled servers need shared
mailboxes with the same ordering and retry behavior.
