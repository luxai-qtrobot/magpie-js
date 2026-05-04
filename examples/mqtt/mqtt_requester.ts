/**
 * MQTT RPC Requester example.
 *
 * Sends RPC requests to the free HiveMQ public test broker at 1 Hz.
 * No account or credentials required.
 *
 * Usage (run together with mqtt_responder.ts or mqtt_responder.py):
 *   Terminal 1:  npm run example:responder
 *   Terminal 2:  npm run example:requester
 *
 * Fully interoperable with examples/mqtt_responder.py from magpie (Python).
 */

import { MqttConnection, MqttRpcRequester, AckTimeoutError, ReplyTimeoutError } from '../src'
import { Logger } from '../src'

const BROKER_URI   = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt (use ws:// or wss:// in browser/React)
const SERVICE_NAME = 'magpie/examples'

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-requester-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const client = new MqttRpcRequester(conn, SERVICE_NAME)

  let count = 1

  const timer = setInterval(async () => {
    try {
      const response = await client.call({ count, action: 'greet' }, 5.0)
      Logger.info(`call #${count} response: ${JSON.stringify(response)}`)
      count++
    } catch (err) {
      if (err instanceof AckTimeoutError || err instanceof ReplyTimeoutError) {
        Logger.warning(`RPC call timed out — is mqtt_responder running?`)
      } else {
        Logger.error(`RPC error: ${err}`)
      }
    }
  }, 1000)

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    clearInterval(timer)
    client.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
