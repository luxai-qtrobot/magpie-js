/**
 * MQTT Publisher example.
 *
 * Publishes a message to a topic at 1 Hz using the free HiveMQ public test broker.
 * No account or credentials required.
 *
 * Usage (run together with mqtt_subscriber.ts or mqtt_subscriber.py):
 *   Terminal 1:  npm run example:publisher
 *   Terminal 2:  npm run example:subscriber
 *
 * Fully interoperable with examples/mqtt_subscriber.py from magpie (Python).
 */

import { MqttConnection, MqttPublisher } from '../src'
import { Logger } from '../src'

const BROKER_URI = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt
const TOPIC      = 'magpie/examples/pubsub'

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-pub-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const pub = new MqttPublisher(conn)

  let count = 1

  const timer = setInterval(async () => {
    await pub.write({ count, msg: 'hello from magpie-js' }, TOPIC)
    Logger.info(`published #${count} to '${TOPIC}'`)
    count++
  }, 1000)

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    clearInterval(timer)
    pub.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
