import { JsonRpcSchema, JsonSchemaToolEntry, MethodFunc, RegisterOptions } from './JsonRpcSchema'

export const MCP_PROTOCOL_VERSION = '2024-11-05'

// Built-in MCP method names — never exposed as tools
const BUILTIN_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'tools/list',
  'tools/call',
  'ping',
])

interface ToolEntry {
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}


export interface McpSchemaOptions {
  name?: string
  version?: string
}

function toText(value: unknown): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

export class McpSchema extends JsonRpcSchema {
  private _serverName: string
  private _serverVersion: string
  private _tools = new Map<string, ToolEntry>()

  constructor(options?: McpSchemaOptions) {
    super()
    this._serverName = options?.name ?? 'magpie'
    this._serverVersion = options?.version ?? '1.0.0'

    // Register built-in MCP handlers directly into _methods, bypassing
    // the tool-tracking logic in our overridden register().
    this._methods.set('initialize', {
      func: () => this._mcpInitialize(),
      description: 'MCP initialize handshake',
      inputSchema: { type: 'object' },
      outputSchema: null,
    })
    this._methods.set('notifications/initialized', {
      func: () => undefined,
      description: '',
      inputSchema: { type: 'object' },
      outputSchema: null,
    })
    this._methods.set('notifications/cancelled', {
      func: () => undefined,
      description: '',
      inputSchema: { type: 'object' },
      outputSchema: null,
    })
    this._methods.set('ping', {
      func: () => ({}),
      description: 'MCP ping',
      inputSchema: { type: 'object' },
      outputSchema: null,
    })
    this._methods.set('tools/list', {
      func: () => this._mcpToolsList(),
      description: 'List available tools',
      inputSchema: { type: 'object' },
      outputSchema: null,
    })
    this._methods.set('tools/call', {
      func: (params?: unknown) => this._mcpToolsCall(params as Record<string, unknown> | undefined),
      description: 'Call a tool by name',
      inputSchema: {
        type: 'object',
        properties: {
          name:      { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['name'],
      },
      outputSchema: null,
    })
  }

  // ----------------------------------------------------------------
  // Registration — tracks user methods as tools
  // ----------------------------------------------------------------

  register(name: string, func?: MethodFunc | null, options?: RegisterOptions): void {
    super.register(name, func, options)

    if (!BUILTIN_METHODS.has(name)) {
      const entry = this._methods.get(name)!
      const tool: ToolEntry = {
        description: entry.description,
        inputSchema: entry.inputSchema,
      }
      // MCP structuredContent must be a dict — only expose outputSchema for object-type schemas
      if (entry.outputSchema?.type === 'object') {
        tool.outputSchema = entry.outputSchema
      }
      this._tools.set(name, tool)
    }
  }

  // ----------------------------------------------------------------
  // Load from JSON — accepts {"tools": [...]} wrapper or plain array
  // ----------------------------------------------------------------

  /** Load a schema from a parsed JS array (or MCP-style `{ tools: [...] }` object). */
  static fromJSON(items: JsonSchemaToolEntry[] | { tools: JsonSchemaToolEntry[] }, options?: McpSchemaOptions): McpSchema {
    const list = Array.isArray(items) ? items : (items.tools ?? [])
    const schema = new McpSchema(options)
    JsonRpcSchema._loadInto(schema, list)
    return schema
  }

  /** Load a schema from a JSON string (plain array or `{"tools": [...]}` wrapper). */
  static fromJsonString(s: string, options?: McpSchemaOptions): McpSchema {
    const data = JSON.parse(s)
    return McpSchema.fromJSON(data, options)
  }

  // ----------------------------------------------------------------
  // Built-in MCP handlers
  // ----------------------------------------------------------------

  private _mcpInitialize(): Record<string, unknown> {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: this._serverName,
        version: this._serverVersion,
      },
    }
  }

  private _mcpToolsList(): Record<string, unknown> {
    const tools = []
    for (const [toolName, meta] of this._tools) {
      const entry: Record<string, unknown> = {
        name: toolName,
        description: meta.description,
        inputSchema: meta.inputSchema,
      }
      if (meta.outputSchema != null) entry.outputSchema = meta.outputSchema
      tools.push(entry)
    }
    return { tools }
  }

  private async _mcpToolsCall(
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = typeof params?.name === 'string' ? params.name : null
    if (!name) throw new Error("'name' is required")

    const entry = this._methods.get(name)
    const tool = this._tools.get(name)

    if (!entry || !tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
    if (!entry.func) {
      return { content: [{ type: 'text', text: `Tool not implemented: ${name}` }], isError: true }
    }

    try {
      const result = await Promise.resolve(entry.func(params?.arguments as Record<string, unknown>))
      const response: Record<string, unknown> = {
        content: [{ type: 'text', text: toText(result) }],
        isError: false,
      }
      // structuredContent only when outputSchema is object-type AND result is a plain object
      if (tool.outputSchema != null && typeof result === 'object' && result !== null && !Array.isArray(result)) {
        response.structuredContent = result
      }
      return response
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message ?? String(e) }], isError: true }
    }
  }
}
