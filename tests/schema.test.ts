import { describe, it, expect, vi } from 'vitest'
import { JsonRpcSchema, JsonRpcError, createJsonRpcClient, METHOD_NOT_FOUND, INTERNAL_ERROR } from '../src/schema/JsonRpcSchema'
import { McpSchema } from '../src/schema/McpSchema'
import { RpcRequester } from '../src/transport/RpcRequester'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(method: string, params?: unknown, id: unknown = 1): Record<string, unknown> {
  const r: Record<string, unknown> = { jsonrpc: '2.0', method, id }
  if (params !== undefined) r.params = params
  return r
}

function notif(method: string, params?: unknown): Record<string, unknown> {
  const r: Record<string, unknown> = { jsonrpc: '2.0', method }
  if (params !== undefined) r.params = params
  return r
}

// ---------------------------------------------------------------------------
// JsonRpcSchema — dispatch
// ---------------------------------------------------------------------------

describe('JsonRpcSchema dispatch', () => {
  it('dispatches named params to registered handler', async () => {
    const schema = new JsonRpcSchema()
    schema.register('add', (p: unknown) => {
      const { a, b } = p as { a: number; b: number }
      return a + b
    })
    const resp = await schema.dispatch(req('add', { a: 3, b: 4 })) as Record<string, unknown>
    expect(resp.result).toBe(7)
  })

  it('dispatches positional params', async () => {
    const schema = new JsonRpcSchema()
    schema.register('add', (...args: unknown[]) => (args[0] as number) + (args[1] as number))
    const resp = await schema.dispatch(req('add', [10, 20])) as Record<string, unknown>
    expect(resp.result).toBe(30)
  })

  it('returns METHOD_NOT_FOUND for unknown method', async () => {
    const schema = new JsonRpcSchema()
    const resp = await schema.dispatch(req('nope')) as Record<string, unknown>
    expect((resp.error as Record<string, unknown>).code).toBe(METHOD_NOT_FOUND)
  })

  it('returns METHOD_NOT_FOUND when func not attached', async () => {
    const schema = new JsonRpcSchema()
    schema.register('stub', null)
    const resp = await schema.dispatch(req('stub')) as Record<string, unknown>
    expect((resp.error as Record<string, unknown>).code).toBe(METHOD_NOT_FOUND)
  })

  it('returns INTERNAL_ERROR when handler throws', async () => {
    const schema = new JsonRpcSchema()
    schema.register('boom', () => { throw new Error('kaboom') })
    const resp = await schema.dispatch(req('boom', {})) as Record<string, unknown>
    expect((resp.error as Record<string, unknown>).code).toBe(INTERNAL_ERROR)
    expect((resp.error as Record<string, unknown>).message).toContain('kaboom')
  })

  it('returns null for unknown notification (no id)', async () => {
    const schema = new JsonRpcSchema()
    const resp = await schema.dispatch(notif('nope'))
    expect(resp).toBeNull()
  })

  it('returns null for known notification (no id)', async () => {
    const schema = new JsonRpcSchema()
    schema.register('log', () => undefined)
    const resp = await schema.dispatch(notif('log', { msg: 'hi' }))
    expect(resp).toBeNull()
  })

  it('handles async handler', async () => {
    const schema = new JsonRpcSchema()
    schema.register('slow', async () => 42)
    const resp = await schema.dispatch(req('slow')) as Record<string, unknown>
    expect(resp.result).toBe(42)
  })

  it('dispatches batch requests', async () => {
    const schema = new JsonRpcSchema()
    schema.register('ping', () => 'pong')
    const resp = await schema.dispatch([req('ping', undefined, 1), req('ping', undefined, 2)]) as unknown[]
    expect(resp).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// JsonRpcSchema — registration
// ---------------------------------------------------------------------------

describe('JsonRpcSchema register / handler', () => {
  it('handler() attaches implementation to pre-defined method', async () => {
    const schema = new JsonRpcSchema()
    schema.register('add', null, {
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    })
    schema.handler('add', (p: unknown) => {
      const { a, b } = p as { a: number; b: number }
      return a + b
    })
    const resp = await schema.dispatch(req('add', { a: 5, b: 3 })) as Record<string, unknown>
    expect(resp.result).toBe(8)
  })

  it('handler() throws for undefined method name', () => {
    const schema = new JsonRpcSchema()
    expect(() => schema.handler('missing', () => 0)).toThrow()
  })

  it('stores description from options', () => {
    const schema = new JsonRpcSchema()
    schema.register('greet', null, { description: 'Say hello' })
    expect(schema['_methods'].get('greet')!.description).toBe('Say hello')
  })

  it('stores inputSchema from options', () => {
    const schema = new JsonRpcSchema()
    const input = { type: 'object', properties: { x: { type: 'number' } } }
    schema.register('foo', null, { inputSchema: input })
    expect(schema['_methods'].get('foo')!.inputSchema).toEqual(input)
  })

  it('defaults inputSchema to {type:object} when omitted', () => {
    const schema = new JsonRpcSchema()
    schema.register('foo', () => 0)
    expect(schema['_methods'].get('foo')!.inputSchema).toEqual({ type: 'object' })
  })
})

// ---------------------------------------------------------------------------
// JsonRpcSchema — fromJsonString / fromJsonFile
// ---------------------------------------------------------------------------

describe('JsonRpcSchema fromJsonString', () => {
  const API = JSON.stringify([
    { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    { name: 'greet', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  ])

  it('loads methods from JSON string', () => {
    const schema = JsonRpcSchema.fromJsonString(API)
    expect(schema['_methods'].has('add')).toBe(true)
    expect(schema['_methods'].has('greet')).toBe(true)
  })

  it('preserves description', () => {
    const schema = JsonRpcSchema.fromJsonString(API)
    expect(schema['_methods'].get('add')!.description).toBe('Add two numbers')
  })

  it('preserves inputSchema', () => {
    const schema = JsonRpcSchema.fromJsonString(API)
    expect((schema['_methods'].get('add')!.inputSchema as Record<string, unknown>).properties).toBeDefined()
  })

  it('throws for non-array input', () => {
    expect(() => JsonRpcSchema.fromJsonString('"not an array"')).toThrow(TypeError)
  })

  it('throws for entry missing name', () => {
    expect(() => JsonRpcSchema.fromJsonString('[{"description": "no name"}]')).toThrow()
  })

  it('loaded method without handler returns METHOD_NOT_FOUND', async () => {
    const schema = JsonRpcSchema.fromJsonString(API)
    const resp = await schema.dispatch(req('add', { a: 1, b: 2 })) as Record<string, unknown>
    expect((resp.error as Record<string, unknown>).code).toBe(METHOD_NOT_FOUND)
  })

  it('works after attaching handler', async () => {
    const schema = JsonRpcSchema.fromJsonString(API)
    schema.handler('add', (p: unknown) => {
      const { a, b } = p as { a: number; b: number }
      return a + b
    })
    const resp = await schema.dispatch(req('add', { a: 2, b: 3 })) as Record<string, unknown>
    expect(resp.result).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// JsonRpcSchema — wrap / unwrap
// ---------------------------------------------------------------------------

describe('JsonRpcSchema wrap/unwrap', () => {
  it('wrap builds a valid JSON-RPC 2.0 envelope', () => {
    const schema = new JsonRpcSchema()
    const env = schema.wrap('add', { a: 1, b: 2 })
    expect(env.jsonrpc).toBe('2.0')
    expect(env.method).toBe('add')
    expect(env.params).toEqual({ a: 1, b: 2 })
    expect(typeof env.id).toBe('number')
  })

  it('wrap increments id counter', () => {
    const schema = new JsonRpcSchema()
    const a = schema.wrap('x')
    const b = schema.wrap('x')
    expect((b.id as number) - (a.id as number)).toBe(1)
  })

  it('unwrap returns result', () => {
    const schema = new JsonRpcSchema()
    expect(schema.unwrap({ jsonrpc: '2.0', result: 42, id: 1 })).toBe(42)
  })

  it('unwrap throws JsonRpcError on error response', () => {
    const schema = new JsonRpcSchema()
    expect(() =>
      schema.unwrap({ jsonrpc: '2.0', error: { code: -32601, message: 'not found' }, id: 1 })
    ).toThrow(JsonRpcError)
  })

  it('unwrap throws on non-object response', () => {
    const schema = new JsonRpcSchema()
    expect(() => schema.unwrap('bad')).toThrow(JsonRpcError)
  })
})

// ---------------------------------------------------------------------------
// createJsonRpcClient — proxy
// ---------------------------------------------------------------------------

describe('createJsonRpcClient', () => {
  function makeMockRequester(responseFactory: (req: unknown) => unknown): RpcRequester {
    return {
      call: vi.fn(async (request: unknown) => responseFactory(request)),
      close: vi.fn(),
    } as unknown as RpcRequester
  }

  it('call() wraps, sends, and unwraps', async () => {
    const schema = new JsonRpcSchema()
    schema.register('add')
    const mockReq = makeMockRequester(() => ({ jsonrpc: '2.0', result: 7, id: 1 }))
    const client = createJsonRpcClient(mockReq, schema)
    const result = await client.call('add', { a: 3, b: 4 })
    expect(result).toBe(7)
  })

  it('proxy intercepts unknown property as method call', async () => {
    const schema = new JsonRpcSchema()
    schema.register('add')
    const mockReq = makeMockRequester(() => ({ jsonrpc: '2.0', result: 9, id: 1 }))
    const client = createJsonRpcClient(mockReq, schema)
    // client.add is intercepted by Proxy
    const result = await client.add({ a: 4, b: 5 })
    expect(result).toBe(9)
    expect(mockReq.call).toHaveBeenCalledTimes(1)
  })

  it('close() delegates to requester', () => {
    const schema = new JsonRpcSchema()
    const mockReq = makeMockRequester(() => null)
    const client = createJsonRpcClient(mockReq, schema)
    client.close()
    expect(mockReq.close).toHaveBeenCalled()
  })

  it('throws JsonRpcError on error response', async () => {
    const schema = new JsonRpcSchema()
    schema.register('fail')
    const mockReq = makeMockRequester(() => ({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'not found' },
      id: 1,
    }))
    const client = createJsonRpcClient(mockReq, schema)
    await expect(client.call('fail')).rejects.toThrow(JsonRpcError)
  })
})

// ---------------------------------------------------------------------------
// McpSchema — initialize / ping / notifications
// ---------------------------------------------------------------------------

describe('McpSchema built-in handlers', () => {
  it('initialize returns protocol version and server info', async () => {
    const schema = new McpSchema({ name: 'testbot', version: '0.1.0' })
    const resp = await schema.dispatch(req('initialize', { protocolVersion: '2024-11-05', capabilities: {} })) as Record<string, unknown>
    const result = resp.result as Record<string, unknown>
    expect(result.protocolVersion).toBe('2024-11-05')
    expect((result.serverInfo as Record<string, unknown>).name).toBe('testbot')
    expect((result.serverInfo as Record<string, unknown>).version).toBe('0.1.0')
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined()
  })

  it('ping returns empty object', async () => {
    const schema = new McpSchema()
    const resp = await schema.dispatch(req('ping', {})) as Record<string, unknown>
    expect(resp.result).toEqual({})
  })

  it('notifications/initialized returns null (no reply)', async () => {
    const schema = new McpSchema()
    const resp = await schema.dispatch(notif('notifications/initialized'))
    expect(resp).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// McpSchema — tools/list
// ---------------------------------------------------------------------------

describe('McpSchema tools/list', () => {
  it('lists registered tools', async () => {
    const schema = new McpSchema()
    schema.register('translate', (p: unknown) => p, {
      description: 'Translate text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    })
    const resp = await schema.dispatch(req('tools/list', {})) as Record<string, unknown>
    const tools = (resp.result as Record<string, unknown>).tools as Record<string, unknown>[]
    expect(tools.map(t => t.name)).toContain('translate')
  })

  it('does not expose built-in methods as tools', async () => {
    const schema = new McpSchema()
    const resp = await schema.dispatch(req('tools/list', {})) as Record<string, unknown>
    const names = ((resp.result as Record<string, unknown>).tools as Record<string, unknown>[]).map(t => t.name)
    expect(names).not.toContain('initialize')
    expect(names).not.toContain('tools/list')
    expect(names).not.toContain('ping')
  })

  it('exposes outputSchema only for object-type return', async () => {
    const schema = new McpSchema()
    schema.register('get_status', () => ({ ok: true }), {
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
    schema.register('get_score', () => 42, {
      outputSchema: { type: 'number' },
    })
    const resp = await schema.dispatch(req('tools/list', {})) as Record<string, unknown>
    const tools = Object.fromEntries(
      ((resp.result as Record<string, unknown>).tools as Record<string, unknown>[])
        .map(t => [t.name, t])
    )
    expect(tools['get_status'].outputSchema).toBeDefined()
    expect(tools['get_score'].outputSchema).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// McpSchema — tools/call
// ---------------------------------------------------------------------------

describe('McpSchema tools/call', () => {
  it('calls registered tool and returns content', async () => {
    const schema = new McpSchema()
    schema.register('add', (p: unknown) => {
      const { a, b } = p as { a: number; b: number }
      return a + b
    })
    const resp = await schema.dispatch(req('tools/call', { name: 'add', arguments: { a: 3, b: 4 } })) as Record<string, unknown>
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(false)
    expect((result.content as Record<string, unknown>[])[0].text).toContain('7')
  })

  it('returns isError:true for unknown tool', async () => {
    const schema = new McpSchema()
    const resp = await schema.dispatch(req('tools/call', { name: 'nope' })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).isError).toBe(true)
  })

  it('returns isError:true when tool handler not attached', async () => {
    const schema = new McpSchema()
    schema.register('stub', null)
    const resp = await schema.dispatch(req('tools/call', { name: 'stub' })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).isError).toBe(true)
  })

  it('returns isError:true when tool throws', async () => {
    const schema = new McpSchema()
    schema.register('boom', () => { throw new Error('oops') })
    const resp = await schema.dispatch(req('tools/call', { name: 'boom', arguments: {} })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// McpSchema — structuredContent
// ---------------------------------------------------------------------------

describe('McpSchema structuredContent', () => {
  it('includes structuredContent when outputSchema is object and result is dict', async () => {
    const schema = new McpSchema()
    schema.register('get_status', () => ({ ok: true, code: 0 }), {
      outputSchema: { type: 'object' },
    })
    const resp = await schema.dispatch(req('tools/call', { name: 'get_status' })) as Record<string, unknown>
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ ok: true, code: 0 })
  })

  it('does not include structuredContent for scalar result', async () => {
    const schema = new McpSchema()
    schema.register('add', (p: unknown) => {
      const { a, b } = p as { a: number; b: number }
      return a + b
    })
    const resp = await schema.dispatch(req('tools/call', { name: 'add', arguments: { a: 1, b: 2 } })) as Record<string, unknown>
    const result = resp.result as Record<string, unknown>
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toBeUndefined()
  })

  it('scalar outputSchema is not exposed in tools/list', async () => {
    const schema = new McpSchema()
    schema.register('add', (p: unknown) => (p as { a: number }).a, {
      outputSchema: { type: 'number' },
    })
    const resp = await schema.dispatch(req('tools/list', {})) as Record<string, unknown>
    const tools = Object.fromEntries(
      ((resp.result as Record<string, unknown>).tools as Record<string, unknown>[]).map(t => [t.name, t])
    )
    expect(tools['add'].outputSchema).toBeUndefined()
  })

  it('does not include structuredContent when no outputSchema declared', async () => {
    const schema = new McpSchema()
    schema.register('echo', (p: unknown) => p)
    const resp = await schema.dispatch(req('tools/call', { name: 'echo', arguments: { x: 1 } })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).structuredContent).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// McpSchema — fromJsonString / fromJsonFile
// ---------------------------------------------------------------------------

describe('McpSchema fromJsonString', () => {
  const MCP_TOOLS = JSON.stringify([
    {
      name: 'translate',
      description: 'Translate text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'get_info',
      description: 'Get info',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { version: { type: 'string' } } },
    },
  ])

  it('loads from plain array', () => {
    const schema = McpSchema.fromJsonString(MCP_TOOLS)
    expect(schema['_tools'].has('translate')).toBe(true)
    expect(schema['_tools'].has('get_info')).toBe(true)
  })

  it('loads from {"tools": [...]} wrapper', () => {
    const schema = McpSchema.fromJsonString(JSON.stringify({ tools: JSON.parse(MCP_TOOLS) }))
    expect(schema['_tools'].has('translate')).toBe(true)
  })

  it('accepts name and version options', async () => {
    const schema = McpSchema.fromJsonString(MCP_TOOLS, { name: 'mybot', version: '2.0' })
    const resp = await schema.dispatch(req('initialize', {})) as Record<string, unknown>
    const info = (resp.result as Record<string, unknown>).serverInfo as Record<string, unknown>
    expect(info.name).toBe('mybot')
    expect(info.version).toBe('2.0')
  })

  it('object outputSchema is exposed in tools/list', async () => {
    const schema = McpSchema.fromJsonString(MCP_TOOLS)
    const resp = await schema.dispatch(req('tools/list', {})) as Record<string, unknown>
    const tools = Object.fromEntries(
      ((resp.result as Record<string, unknown>).tools as Record<string, unknown>[]).map(t => [t.name, t])
    )
    expect(tools['get_info'].outputSchema).toBeDefined()
    expect(tools['translate'].outputSchema).toBeUndefined()
  })

  it('tool without handler returns isError:true on call', async () => {
    const schema = McpSchema.fromJsonString(MCP_TOOLS)
    const resp = await schema.dispatch(req('tools/call', { name: 'translate', arguments: { text: 'Hi' } })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).isError).toBe(true)
  })

  it('handler() attaches implementation and tool works', async () => {
    const schema = McpSchema.fromJsonString(MCP_TOOLS)
    schema.handler('translate', (p: unknown) => {
      const { text } = p as { text: string }
      return { translated: `[en] ${text}` }
    })
    const resp = await schema.dispatch(req('tools/call', { name: 'translate', arguments: { text: 'Hello' } })) as Record<string, unknown>
    expect((resp.result as Record<string, unknown>).isError).toBe(false)
    expect(JSON.stringify((resp.result as Record<string, unknown>).content)).toContain('Hello')
  })
})
