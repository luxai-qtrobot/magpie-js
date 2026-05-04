/**
 * MQTT MCP server using McpSchema.
 *
 * Exposes tools over MQTT. Any MCP client (e.g. mqtt_mcp_client.ts)
 * can call tools via the standard MCP protocol.
 *
 * Run this first, then run mqtt_mcp_client.ts.
 */
import { MqttConnection, MqttRpcResponder } from '../../src/transport/index'
import { McpSchema } from '../../src/schema/index'
import { Logger } from '../../src/utils/logger'

const schema = new McpSchema({ name: 'my-service', version: '1.0.0' })

schema.register(
  'translate',
  (p: unknown) => {
    const { text, target_lang } = p as { text: string; target_lang: string }
    return { translated: `[${target_lang}] ${text}`, lang: target_lang }
  },
  {
    description: 'Translate text into the target language.',
    inputSchema: {
      type: 'object',
      properties: {
        text:        { type: 'string' },
        target_lang: { type: 'string' },
      },
      required: ['text', 'target_lang'],
    },
    outputSchema: { type: 'object' },
  },
)

schema.register(
  'summarize',
  (p: unknown) => {
    const { text, max_length } = p as { text: string; max_length: number }
    return { summary: text.slice(0, max_length) }
  },
  {
    description: 'Summarize text to at most max_length characters.',
    inputSchema: {
      type: 'object',
      properties: {
        text:       { type: 'string' },
        max_length: { type: 'integer' },
      },
      required: ['text', 'max_length'],
    },
    outputSchema: { type: 'object' },
  },
)

async function main() {
  Logger.setLevel('DEBUG')

  const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
  await conn.connect()

  const server = new MqttRpcResponder(conn, 'node-01', { schema })
  Logger.info('mqtt_mcp_server: listening on node-01')

  process.on('SIGINT', async () => {
    Logger.info('stopping...')
    server.close()
    await conn.disconnect()
    process.exit(0)
  })
}

main()
