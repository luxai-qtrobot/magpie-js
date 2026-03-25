/**
 * MQTT RPC Responder example.
 *
 * Listens for RPC requests on the free HiveMQ public test broker and echoes
 * them back with an "ok" status. No account or credentials required.
 *
 * Usage (run together with mqtt_requester.ts or mqtt_requester.py):
 *   Terminal 1:  npm run example:responder
 *   Terminal 2:  npm run example:requester
 *
 * Fully interoperable with examples/mqtt_requester.py from magpie (Python).
 */

import { MqttConnection, MqttRpcResponder } from '../src'
import { Logger } from '../src'

const BROKER_URI   = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt (use ws:// or wss:// in browser/React)
const SERVICE_NAME = 'magpie/examples'

function onRequest(request: unknown): unknown {
  Logger.info(`on_request: ${JSON.stringify(request)}`)
  return { status: 'ok', echo: request }
}

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-responder-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const responder = new MqttRpcResponder(conn, SERVICE_NAME)
  responder.onRequest(onRequest)

  Logger.info(`listening for RPC requests on service '${SERVICE_NAME}'...`)

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    responder.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
