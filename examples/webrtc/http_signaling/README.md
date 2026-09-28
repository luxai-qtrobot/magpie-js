# Copyable Node HTTP signaling relay

`relay.cjs` uses Node built-ins and does not import MAGPIE. Copy it into an
existing web application. `InMemoryRelay` holds the two peer mailboxes,
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
| `PUT /sessions/{session}/peers/{peer}` | Join or renew; 409 when two peers are present |
| `POST /sessions/{session}/peers/{peer}/messages` | Forward opaque bytes to the other peer; include `X-Magpie-Message-Id` |
| `GET /sessions/{session}/peers/{peer}/messages?after=N&wait=S` | Long-poll, returning bytes and `X-Magpie-Sequence` |
| `DELETE /sessions/{session}/peers/{peer}` | Leave |

The client prepends its configured base URL and encodes each ID as unpadded
URL-safe Base64 of UTF-8. POST bodies and GET response bodies are opaque bytes.
The relay preserves each recipient's message order, suppresses repeated POSTs
with the same message ID, and replays a message until the GET cursor advances.
If the recipient has not joined, an accepted message can be dropped; the
client repeats its initial hello. Mailboxes expire after 90 seconds without
activity. The helper is single-process and in-memory; scaled servers need
shared mailboxes with the same ordering and retry behavior.
