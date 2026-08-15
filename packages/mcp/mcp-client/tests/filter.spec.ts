/**
 * Tests for the mcp-client tool filtering surface: `toolAllow`, `toolDeny`,
 * and `descriptionMaxLength`. Isolated file so vi.mock of the MCP SDK doesn't
 * pollute other test suites (mirrors apply.spec.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    request = mockRequest
    setNotificationHandler = vi.fn()
  }
  return { mockConnect, mockClose, mockListTools, MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the module under test sees the
// mocked SDK even through a static import.
import { apply, Config as ConfigSchema } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const baseConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

/** The three fixture tools the mocked server lists in every test. */
const listedTools = [
  { name: 'keep', description: 'A kept tool', inputSchema: { type: 'object' } },
  { name: 'drop', description: 'A dropped tool', inputSchema: { type: 'object' } },
  { name: 'long', description: 'A very long description '.repeat(10).trim(), inputSchema: { type: 'object' } },
]

function publicName(raw: string): string {
  return `mcp__srv__${raw}`
}

// ---- Tests ----

describe('mcp-client tool filtering', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({ tools: listedTools, nextCursor: undefined })
    ctx = await mountRegistry()
  })

  it('registers every listed tool by default', async () => {
    await apply(ctx, baseConfig)

    for (const raw of ['keep', 'drop', 'long']) {
      expect(ctx.tools.get(publicName(raw))).toBeDefined()
    }
  })

  it('toolAllow registers only the listed raw names', async () => {
    await apply(ctx, { ...baseConfig, toolAllow: ['keep'] })

    expect(ctx.tools.get(publicName('keep'))).toBeDefined()
    expect(ctx.tools.get(publicName('drop'))).toBeUndefined()
    expect(ctx.tools.get(publicName('long'))).toBeUndefined()
  })

  it('an empty toolAllow array is a no-op (allow all)', async () => {
    await apply(ctx, { ...baseConfig, toolAllow: [] })

    expect(ctx.tools.get(publicName('keep'))).toBeDefined()
    expect(ctx.tools.get(publicName('drop'))).toBeDefined()
  })

  it('toolDeny unregisters the listed raw names', async () => {
    await apply(ctx, { ...baseConfig, toolDeny: ['drop'] })

    expect(ctx.tools.get(publicName('keep'))).toBeDefined()
    expect(ctx.tools.get(publicName('drop'))).toBeUndefined()
    expect(ctx.tools.get(publicName('long'))).toBeDefined()
  })

  it('deny wins over allow for the same raw name', async () => {
    await apply(ctx, { ...baseConfig, toolAllow: ['keep', 'drop'], toolDeny: ['drop'] })

    expect(ctx.tools.get(publicName('keep'))).toBeDefined()
    expect(ctx.tools.get(publicName('drop'))).toBeUndefined()
  })

  it('descriptionMaxLength truncates long descriptions with an ellipsis', async () => {
    await apply(ctx, { ...baseConfig, descriptionMaxLength: 30 })

    const schemas = ctx.tools.schemas()
    const long = schemas.find(schema => schema.name === publicName('long'))
    expect(long?.description.length).toBe(30)
    expect(long?.description.endsWith('…')).toBe(true)
    const keep = schemas.find(schema => schema.name === publicName('keep'))
    expect(keep?.description).toBe('A kept tool')
  })

  it('filtering every listed tool still activates with nothing registered', async () => {
    await apply(ctx, { ...baseConfig, toolAllow: ['missing'] })

    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('mcp__srv__'))).toBe(false)
  })

  it('Config schema accepts and preserves the filter fields', () => {
    const resolved = ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      toolAllow: ['keep'],
      toolDeny: ['drop'],
      descriptionMaxLength: 30,
    } as never)

    expect(resolved.toolAllow).toEqual(['keep'])
    expect(resolved.toolDeny).toEqual(['drop'])
    expect(resolved.descriptionMaxLength).toBe(30)
  })

  it('Config schema rejects a non-positive descriptionMaxLength', () => {
    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      descriptionMaxLength: 0,
    } as never)).toThrow()
  })
})
