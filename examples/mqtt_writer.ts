/**
 * MQTT Writer example.
 *
 * Writes a message to a topic at 1 Hz using the free HiveMQ public test broker.
 * No account or credentials required.
 *
 * Usage (run together with mqtt_reader.ts or mqtt_reader.py):
 *   Terminal 1:  npm run example:writer
 *   Terminal 2:  npm run example:reader
 *
 * Fully interoperable with examples/mqtt_reader.py from magpie (Python).
 */

import { MqttConnection, MqttStreamWriter } from '../src'
import { Logger } from '../src'

const BROKER_URI = 'mqtt://broker.hivemq.com:1883' // wss://broker.hivemq.com:8884/mqtt
const TOPIC      = 'magpie/examples/stream'

async function main() {
  const conn = new MqttConnection(BROKER_URI, { clientId: 'magpie-js-writer-example' })

  try {
    await conn.connect(10_000)
  } catch (err) {
    Logger.error(`Could not connect to broker: ${err}`)
    process.exit(1)
  }

  const writer = new MqttStreamWriter(conn)

  let count = 1

  const timer = setInterval(async () => {
    await writer.write({ count, msg: 'hello from magpie-js' }, TOPIC)
    Logger.info(`wrote #${count} to '${TOPIC}'`)
    count++
  }, 1000)

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    clearInterval(timer)
    writer.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
