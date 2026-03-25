<p align="center">
  <img src="src/assets/magpie.png" alt="MAGPIE Logo" width="200"/>
</p>

<h1 align="center">MAGPIE.js</h1>
<p align="center"><em>Message Abstraction & General-Purpose Integration Engine — TypeScript/JavaScript</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@luxai-qtrobot/magpie">
    <img src="https://img.shields.io/npm/v/@luxai-qtrobot/magpie" alt="npm version"/>
  </a>
  <a href="https://www.npmjs.com/package/@luxai-qtrobot/magpie">
    <img src="https://img.shields.io/npm/l/@luxai-qtrobot/magpie" alt="License"/>
  </a>
  <a href="https://www.npmjs.com/package/@luxai-qtrobot/magpie">
    <img src="https://img.shields.io/badge/platform-browser%20%7C%20node.js-blue" alt="Platform"/>
  </a>
</p>

---

MAGPIE.js is the TypeScript/JavaScript port of [MAGPIE](https://github.com/luxai-qtrobot/magpie) — a lightweight, transport-agnostic messaging engine for distributed systems. It provides clean abstractions for pub/sub streaming and request/response RPC, built on top of MQTT over WebSocket.

Designed for **full wire-level interoperability** with the Python (`luxai-magpie[mqtt]`) and C++ (`libmagpie-mqtt`) implementations — a browser or Node.js client can talk directly to a Python or C++ MAGPIE node with no adaptation layer.

---

## Features

- **Pub/Sub streaming** — topic-based messaging via `StreamWriter` / `StreamReader`
- **Request/Response RPC** — async-native RPC via `MqttRpcRequester` / `MqttRpcResponder`
- **MQTT transport** — full pub/sub and RPC over MQTT; supports `mqtt://`, `mqtts://`, `ws://`, `wss://`, auth, LWT, and auto-reconnect
- **Pluggable transports** — MQTT today; WebRTC or any custom transport tomorrow without changing user code
- **Fast serialization** — msgpack by default; bring your own serializer via the abstract interface
- **Typed frames** — `DictFrame`, `ImageFrameJpeg`, `AudioFrameRaw`, and more — wire-compatible with Python
- **Browser + Node.js** — one package, works everywhere; use `ws://`/`wss://` in the browser, `mqtt://` in Node.js
- **CDN ready** — single UMD bundle, no bundler required

---

## Installation

### npm

```bash
npm install @luxai-qtrobot/magpie
```

### CDN (no bundler required)

```html
<script src="https://cdn.jsdelivr.net/npm/@luxai-qtrobot/magpie/dist/magpie.umd.js"></script>
```

All exports are available under the global `Magpie` object:

```js
const { MqttConnection, MqttPublisher, MqttSubscriber } = Magpie
```

---

## Quick Start

### Pub / Sub

**Publisher:**

```typescript
import { MqttConnection, MqttPublisher } from '@luxai-qtrobot/magpie'

const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
await conn.connect()

const pub = new MqttPublisher(conn)
await pub.write({ sensor: 'temp', value: 22.5 }, 'sensors/temperature')

pub.close()
await conn.disconnect()
```

**Subscriber:**

```typescript
import { MqttConnection, MqttSubscriber, TimeoutError } from '@luxai-qtrobot/magpie'

const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
await conn.connect()

const sub = new MqttSubscriber(conn, { topic: 'sensors/temperature' })

while (true) {
  try {
    const [data, topic] = await sub.read(5.0)
    console.log(topic, data)
  } catch (err) {
    if (err instanceof TimeoutError) continue
    break
  }
}

sub.close()
await conn.disconnect()
```

Wildcard topics are fully supported:

```typescript
// single-level wildcard
const sub = new MqttSubscriber(conn, { topic: 'sensors/+/temperature' })

// multi-level wildcard
const sub = new MqttSubscriber(conn, { topic: 'sensors/#' })
```

---

### Request / Response RPC

**Requester:**

```typescript
import { MqttConnection, MqttRpcRequester, AckTimeoutError, ReplyTimeoutError } from '@luxai-qtrobot/magpie'

const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
await conn.connect()

const client = new MqttRpcRequester(conn, 'myrobot/motion')

try {
  const response = await client.call({ action: 'move', x: 1.0 }, 5.0)
  console.log('Response:', response)
} catch (err) {
  if (err instanceof AckTimeoutError)   console.error('No ACK — is the responder running?')
  if (err instanceof ReplyTimeoutError) console.error('No reply within timeout')
} finally {
  client.close()
  await conn.disconnect()
}
```

**Responder:**

```typescript
import { MqttConnection, MqttRpcResponder } from '@luxai-qtrobot/magpie'

const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
await conn.connect()

const server = new MqttRpcResponder(conn, 'myrobot/motion')

server.onRequest((request) => {
  console.log('Request:', request)
  return { status: 'ok', echo: request }
})
```

---

### Browser (CDN)

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/@luxai-qtrobot/magpie/dist/magpie.umd.js"></script>
</head>
<body>
<script>
  const { MqttConnection, MqttPublisher, MqttSubscriber } = Magpie

  // Browsers require WebSocket — use ws:// or wss://
  const conn = new MqttConnection('wss://broker.hivemq.com:8884/mqtt')
  await conn.connect()

  const pub = new MqttPublisher(conn)
  await pub.write({ hello: 'from browser' }, 'magpie/test')
</script>
</body>
</html>
```

> **Note:** Browsers cannot open raw TCP connections. Always use `ws://` (plain WebSocket) or `wss://` (WebSocket + TLS) in browser and React applications. Node.js supports all schemes including `mqtt://` and `mqtts://`.

---

### Advanced Connection Options

```typescript
import { MqttConnection, MqttOptions } from '@luxai-qtrobot/magpie'

const conn = new MqttConnection('wss://broker.example.com:8884/mqtt', {
  clientId: 'my-app-001',
  auth: {
    mode: 'username_password',
    username: 'user',
    password: 'secret',
    // mode: 'token' — pass a JWT or API key as username (e.g. Ably, HiveMQ Cloud)
  },
  will: {
    enabled: true,
    topic: 'devices/my-app-001/status',
    payload: 'offline',
    qos: 1,
    retain: true,
  },
  defaults: {
    publishQos: 1,
    subscribeQos: 1,
  },
  reconnect: {
    minDelaySec: 1,
    maxDelaySec: 30,
  },
})

await conn.connect()
```

> **mTLS note:** Client certificate authentication (mTLS) is not supported from browser JavaScript — browsers do not expose APIs to load client certificates programmatically. Use `username_password` or `token` mode for browser clients. mTLS remains available in the Python and C++ MAGPIE implementations for backend-to-backend communication.

---

## Frames

Frames are typed message wrappers that carry standard metadata (`gid`, `id`, `name`, `timestamp`) alongside the payload. They are wire-compatible with Python and C++ MAGPIE frames.

```typescript
import { DictFrame, ImageFrameJpeg, AudioFrameRaw, Frame } from '@luxai-qtrobot/magpie'

// Create and publish a frame
const frame = new DictFrame({ value: { count: 1, msg: 'hello' } })
await pub.write(frame.toDict(), 'myrobot/data')

// Reconstruct a frame received from the wire
const [raw, topic] = await sub.read()
const frame = Frame.fromDict(raw as Record<string, unknown>)
// frame is automatically dispatched to the correct subclass (DictFrame, ImageFrameJpeg, etc.)
```

| Frame | Description |
|---|---|
| `DictFrame` | Arbitrary JSON-like dict payload |
| `BoolFrame` / `IntFrame` / `FloatFrame` / `StringFrame` | Primitive value wrappers |
| `BytesFrame` / `ListFrame` | Binary and list payloads |
| `ImageFrameRaw` / `ImageFrameJpeg` | Image data with width/height/channels metadata |
| `AudioFrameRaw` / `AudioFrameFlac` | PCM or FLAC audio with sample rate/channels metadata |

---

## Interoperability

MAGPIE.js shares the same wire format as the Python and C++ implementations:

- **Serialization:** msgpack (wire-compatible with Python's `msgpack.packb` / `msgpack.unpackb`)
- **RPC protocol:** identical topic structure and message envelope (`rid`, `reply_to`, `payload`)
- **Frames:** identical field names and snake_case keys (e.g. `pixel_format`, `sample_rate`)

This means any combination of Python, C++, and JavaScript nodes can communicate directly through any MQTT broker — no bridges, no adapters.

**Cross-language example:**

```bash
# Terminal 1 — Python responder
python examples/mqtt_responder.py

# Terminal 2 — JS requester talking to the Python responder
npm run example:requester
```

---

## Transport URI schemes

| Scheme | Protocol | Use case |
|---|---|---|
| `mqtt://host:1883` | Plain MQTT (TCP) | Node.js |
| `mqtts://host:8883` | MQTT over TLS (TCP) | Node.js (secure) |
| `ws://host:8000/mqtt` | MQTT over WebSocket | Browser (plain) |
| `wss://host:8884/mqtt` | MQTT over WebSocket + TLS | Browser (secure, recommended) |

---

## Examples

| Example | Description |
|---|---|
| [`examples/mqtt_publisher.ts`](examples/mqtt_publisher.ts) | Publish messages at 1 Hz |
| [`examples/mqtt_subscriber.ts`](examples/mqtt_subscriber.ts) | Subscribe and print messages |
| [`examples/mqtt_requester.ts`](examples/mqtt_requester.ts) | Send RPC requests at 1 Hz |
| [`examples/mqtt_responder.ts`](examples/mqtt_responder.ts) | Echo RPC responder |
| [`examples/browser/demo.html`](examples/browser/demo.html) | Interactive browser demo (pub/sub + RPC) |

Run Node.js examples:

```bash
npm run example:publisher
npm run example:subscriber
npm run example:requester
npm run example:responder
```

Open the browser demo by opening `examples/browser/demo.html` directly in your browser (no server required).

---

## Project Structure

```
src/
  serializer/       BaseSerializer, MsgpackSerializer
  frames/           Frame base + all frame types
  transport/
    StreamReader.ts       abstract subscriber interface
    StreamWriter.ts       abstract publisher interface
    RpcRequester.ts       abstract RPC client interface
    RpcResponder.ts       abstract RPC server interface
    mqtt/                 MQTT transport implementation
```

---

## Development

```bash
npm install        # install dependencies
npm run build      # build ESM, CJS, and UMD bundles
npm test           # run unit tests
npm run typecheck  # TypeScript type check only
```

---

## Related Projects

| Project | Language | Repository |
|---|---|---|
| MAGPIE | Python | [luxai-qtrobot/magpie](https://github.com/luxai-qtrobot/magpie) |
| MAGPIE C++ | C++ (`libmagpie`, `libmagpie-mqtt`) | [luxai-qtrobot/magpie-cpp](https://github.com/luxai-qtrobot/magpie-cpp) |
| MAGPIE.js | TypeScript/JavaScript | this repo |

---

## Project Status

**Status:** Beta — API is stable for the MQTT transport layer. Additional transports (WebRTC, gRPC-web) are planned.

**Roadmap:**
- Additional transports (WebRTC, gRPC-web)
- React hooks (`useMagpieSubscriber`, `useMagpieRequest`)
- Multi-transport support

---

## License

Licensed under the [GNU General Public License v3 (GPLv3)](LICENSE).
