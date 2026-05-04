/**
 * MQTT RPC responder with JsonRpcSchema.
 *
 * Demonstrates two ways to define and attach handlers:
 *
 *   Way A — load API from JSON string, attach handlers separately
 *   Way B — register with explicit schema + handler together
 *
 * Run this first, then run mqtt_schema_requester.ts.
 */
import { MqttConnection, MqttRpcResponder } from '../../src/transport/index'
import { JsonRpcSchema } from '../../src/schema/index'
import { Logger } from '../../src/utils/logger'

// ── Way A: load API from JSON string (no handlers yet) ─────────────────────

const MATH_API = JSON.stringify([
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'sub',
    description: 'Subtract b from a',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
])

const schema = JsonRpcSchema.fromJsonString(MATH_API)

// ── Attach handlers to pre-defined methods ─────────────────────────────────

schema.handler('add', (p: unknown) => {
  const { a, b } = p as { a: number; b: number }
  return a + b
})

schema.handler('sub', (p: unknown) => {
  const { a, b } = p as { a: number; b: number }
  return a - b
})

// ── Way B: register method with handler together ───────────────────────────

schema.register(
  'mul',
  (p: unknown) => {
    const { a, b } = p as { a: number; b: number }
    return a * b
  },
  {
    description: 'Multiply two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
)

schema.register(
  'div',
  (p: unknown) => {
    const { a, b } = p as { a: number; b: number }
    if (b === 0) throw new Error('division by zero')
    return a / b
  },
  {
    description: 'Divide a by b',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
)

// ── Start server ───────────────────────────────────────────────────────────

async function main() {
  Logger.setLevel('DEBUG')

  const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
  await conn.connect()

  const server = new MqttRpcResponder(conn, 'magpie/examples/schema', { schema })
  Logger.info('mqtt_schema_responder: listening on magpie/examples/schema')

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    server.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
