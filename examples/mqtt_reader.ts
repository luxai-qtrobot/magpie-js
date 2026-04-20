/**
 * MQTT Reader example.
 *
 * Subscribes to a topic on the free HiveMQ public test broker.
 * No account or credentials required.
 *
 * Usage (run together with mqtt_writer.ts or mqtt_writer.py):
 *   Terminal 1:  npm run example:writer
 *   Terminal 2:  npm run example:reader
 *
 * Fully interoperable with examples/mqtt_writer.py from magpie (Python).
 *
 * Wildcards are also supported:
 *   topic: 'magpie/examples/+'   single-level wildcard
 *   topic: 'magpie/#'            multi-level wildcard
 */

import { MqttConnection, MqttStreamReader, TimeoutError } from '../src'
import { Logger } from '../src'

const BROKER_URI = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt (use ws:// or wss:// in browser/React)
const TOPIC      = 'magpie/examples/stream'

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-sub-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const sub = new MqttStreamReader(conn, { topic: TOPIC })

  let running = true
  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    running = false
    sub.close()
    await conn.disconnect()
    process.exit(0)
  })

  while (running) {
    try {
      const [data, topic] = await sub.read(5.0)
      Logger.info(`received on '${topic}': ${JSON.stringify(data)}`)
    } catch (err) {
      if (err instanceof TimeoutError) {
        Logger.debug('waiting for messages...')
      } else {
        break
      }
    }
  }
}

main()
