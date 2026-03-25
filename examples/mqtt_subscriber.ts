/**
 * MQTT Subscriber example.
 *
 * Subscribes to a topic on the free HiveMQ public test broker.
 * No account or credentials required.
 *
 * Usage (run together with mqtt_publisher.ts or mqtt_publisher.py):
 *   Terminal 1:  npm run example:publisher
 *   Terminal 2:  npm run example:subscriber
 *
 * Fully interoperable with examples/mqtt_publisher.py from magpie (Python).
 *
 * Wildcards are also supported:
 *   topic: 'magpie/examples/+'   single-level wildcard
 *   topic: 'magpie/#'            multi-level wildcard
 */

import { MqttConnection, MqttSubscriber, TimeoutError } from '../src'
import { Logger } from '../src'

const BROKER_URI = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt (use ws:// or wss:// in browser/React)
const TOPIC      = 'magpie/examples/pubsub'

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-sub-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const sub = new MqttSubscriber(conn, { topic: TOPIC })

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
