/**
 * MQTT MCP client using McpTransport + @modelcontextprotocol/sdk Client.
 *
 * Connects to an MCP server running over MQTT (mqtt_mcp_server.ts)
 * and calls tools via the standard MCP protocol.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 * Run mqtt_mcp_server.ts first.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { MqttConnection, MqttRpcRequester } from '../../src/transport/index'
import { McpTransport } from '../../src/adapters/mcp/index'
import { Logger } from '../../src/utils/logger'

async function main() {
  Logger.setLevel('DEBUG')

  const conn = new MqttConnection('mqtt://broker.hivemq.com:1883')
  await conn.connect()

  const requester = new MqttRpcRequester(conn, 'node-01')
  const transport = new McpTransport(requester)

  const client = new Client({ name: 'magpie-mcp-client', version: '1.0.0' })
  await client.connect(transport)

  try {
    // List available tools
    const { tools } = await client.listTools()
    Logger.info('Available tools:')
    for (const tool of tools) {
      Logger.info(`  ${tool.name}: ${tool.description}`)
    }

    // Call translate
    const translateResult = await client.callTool({
      name: 'translate',
      arguments: { text: 'Hello', target_lang: 'fr' },
    })
    Logger.info(`translate result: ${JSON.stringify(translateResult.content)}`)

    // Call summarize
    const summarizeResult = await client.callTool({
      name: 'summarize',
      arguments: { text: 'This is a long text that needs to be shortened.', max_length: 20 },
    })
    Logger.info(`summarize result: ${JSON.stringify(summarizeResult.content)}`)

  } finally {
    await client.close()
    requester.close()
    await conn.disconnect()
  }
}

main()
