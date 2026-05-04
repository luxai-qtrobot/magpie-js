/**
 * MQTT RPC requester with JsonRpcSchema.
 *
 * Demonstrates all schema definition styles on the requester side and
 * both call styles (proxy and explicit call). Run mqtt_schema_responder.ts first.
 */
import { MqttConnection, MqttRpcRequester } from '../../src/transport/index'
import { JsonRpcSchema, JsonRpcError, createJsonRpcClient } from '../../src/schema/index'
import { Logger } from '../../src/utils/logger'

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
  {
    name: 'mul',
    description: 'Multiply two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'div',
    description: 'Divide a by b',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
])

async function main() {
  Logger.setLevel('DEBUG')

  // Load schema from JSON string
  const schema = JsonRpcSchema.fromJsonString(MATH_API)

  const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
  await conn.connect()

  const requester = new MqttRpcRequester(conn, 'magpie/examples/schema')
  const client = createJsonRpcClient(requester, schema)

  try {
    // ── proxy style ────────────────────────────────────────────────
    Logger.info(`add proxy:  3 + 4 = ${await client.add({ a: 3, b: 4 })}`)
    Logger.info(`sub proxy:  10 - 3 = ${await client.sub({ a: 10, b: 3 })}`)
    Logger.info(`mul proxy:  6 * 7 = ${await client.mul({ a: 6, b: 7 })}`)
    Logger.info(`div proxy:  10 / 4 = ${await client.div({ a: 10, b: 4 })}`)

    // ── explicit call style ────────────────────────────────────────
    Logger.info(`add call:   1 + 2 = ${await client.call('add', { a: 1, b: 2 })}`)

    // ── with explicit timeout ──────────────────────────────────────
    Logger.info(`add timeout: 100 + 200 = ${await client.call('add', { a: 100, b: 200 }, 5)}`)

    // ── error from server (division by zero) ──────────────────────
    try {
      await client.div({ a: 10, b: 0 })
    } catch (e) {
      if (e instanceof JsonRpcError) {
        Logger.warning(`expected server error ${e.code}: ${e.message}`)
      }
    }

    // ── unknown method ─────────────────────────────────────────────
    try {
      await client.call('nonexistent')
    } catch (e) {
      if (e instanceof JsonRpcError) {
        Logger.warning(`expected error ${e.code}: ${e.message}`)
      }
    }
  } finally {
    client.close()
    await conn.disconnect()
  }
}

main()
