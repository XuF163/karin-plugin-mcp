/**
 * karin-plugin-mcp: standalone MCP Server (stdio)
 * - stdout: JSON-RPC (MCP protocol)
 * - stderr: JSON logs (for host / debugging)
 */

import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

type McpToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const ENV = process.env

const baseUrl = ENV.KARIN_MCP_URL
  ? ENV.KARIN_MCP_URL
  : `${ENV.KARIN_BASE_URL || 'http://127.0.0.1:7777'}${ENV.KARIN_MCP_PATH || '/MCP'}`

const MCP_CONFIG = {
  name: 'karin-mcp',
  version: '0.2.0',
  description: 'Karin Bot MCP Server',
  karinUrl: baseUrl,
  apiKey: ENV.KARIN_MCP_API_KEY || ENV.HTTP_AUTH_KEY || '',
}

const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data: unknown = null) => {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

const makeRequest = async (action: string, data: Record<string, unknown> = {}) => {
  const url = `${MCP_CONFIG.karinUrl}/api/${action}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (MCP_CONFIG.apiKey) headers['X-API-Key'] = MCP_CONFIG.apiKey

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
  }

  return await res.json()
}

const MCP_TOOLS: Record<string, McpToolSpec> = {
  bot_status: {
    name: 'bot_status',
    description: '获取 Karin 运行状态与 MCP 插件状态',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  mock_incoming_message: {
    name: 'mock_incoming_message',
    description: 'LLM → Bot 注入入站消息（带 group_id 视为群聊），支持 waitMs + traceId',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        user_id: { type: 'string' },
        group_id: { type: 'string' },
        nickname: { type: 'string' },
        role: { type: 'string', enum: ['member', 'admin', 'owner'] },
        waitMs: { type: 'number' },
        traceId: { type: 'string' },
      },
      required: ['message', 'user_id'],
    },
  },
  mock_status: {
    name: 'mock_status',
    description: '查看 Mock 环境统计（inbox/outbox/trace 数量）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  mock_history: {
    name: 'mock_history',
    description: '查看 Mock 收发历史（type=in/out，可选 limit）',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['in', 'out'] },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  render_screenshot: {
    name: 'render_screenshot',
    description: '通过 Karin 渲染器截图（返回 url / filePath）',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'URL / 本地路径 / HTML 字符串' },
        file_type: { type: 'string', enum: ['auto', 'htmlString', 'vue3', 'vueString', 'react'] },
        type: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        filename: { type: 'string' },
        return: { type: 'string', enum: ['url', 'filePath', 'both'] },
        fullPage: { type: 'boolean' },
        multiPage: { anyOf: [{ type: 'boolean' }, { type: 'number' }] },
        setViewport: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            deviceScaleFactor: { type: 'number' },
          },
        },
        pageGotoParams: { type: 'object' },
        headers: { type: 'object' },
        data: { type: 'object' },
      },
      required: ['file'],
    },
  },
}

const executeTool = async (name: string, args: Record<string, unknown> | undefined) => {
  log('info', `Executing tool: ${name}`, args || null)
  switch (name) {
    case 'bot_status':
      return await makeRequest('bot.status')
    case 'mock_incoming_message':
      return await makeRequest('mock.incoming.message', args || {})
    case 'mock_status':
      return await makeRequest('mock.status')
    case 'mock_history':
      return await makeRequest('mock.history', args || {})
    case 'render_screenshot':
      return await makeRequest('render.screenshot', args || {})
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

class MCPServer {
  initialized = false

  sendResponse (id: unknown, result: unknown = null, error: any = null) {
    const response: any = { jsonrpc: '2.0', id }
    if (error) {
      response.error = {
        code: error.code || -32000,
        message: error.message || 'Unknown error',
        data: error.data,
      }
    } else {
      response.result = result
    }
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }

  sendNotification (method: string, params: Record<string, unknown> = {}) {
    const notification = { jsonrpc: '2.0', method, params }
    process.stdout.write(`${JSON.stringify(notification)}\n`)
  }

  async handleInitialize (id: unknown, params: unknown) {
    log('info', 'MCP Server initializing', params)
    this.sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: { name: MCP_CONFIG.name, version: MCP_CONFIG.version },
    })
    this.initialized = true
    this.sendNotification('notifications/initialized')
  }

  async handleListTools (id: unknown) {
    this.sendResponse(id, { tools: Object.values(MCP_TOOLS) })
  }

  async handleCallTool (id: unknown, params: any) {
    try {
      const { name, arguments: args } = params || {}
      if (!MCP_TOOLS[name]) throw new Error(`Tool not found: ${name}`)

      const finalArgs: Record<string, unknown> = args || {}
      if (name === 'mock_incoming_message' && !finalArgs.traceId) {
        finalArgs.traceId = crypto.randomUUID()
      }

      const result = await executeTool(name, finalArgs)
      this.sendResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      })
    } catch (error: any) {
      this.sendResponse(id, null, { code: -32000, message: error?.message || String(error) })
    }
  }

  async handleMessage (message: any) {
    try {
      const { id, method, params } = message
      switch (method) {
        case 'initialize':
          await this.handleInitialize(id, params)
          break
        case 'tools/list':
          await this.handleListTools(id)
          break
        case 'tools/call':
          await this.handleCallTool(id, params)
          break
        default:
          this.sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` })
      }
    } catch (error: any) {
      log('error', 'Message handling failed', { error: error?.message || String(error), message })
      if (message?.id) this.sendResponse(message.id, null, { code: -32000, message: error?.message || String(error) })
    }
  }

  start () {
    log('info', 'MCP Server starting', MCP_CONFIG)

    process.stdin.setEncoding('utf8')
    let buffer = ''

    process.stdin.on('data', (chunk) => {
      buffer += chunk

      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line)
          void this.handleMessage(message)
        } catch (error: any) {
          log('error', 'JSON parse error', { error: error?.message || String(error), line })
        }
      }
    })

    process.stdin.on('end', () => {
      log('info', 'MCP Server stdin ended, exit')
      process.exit(0)
    })

    process.on('uncaughtException', (error) => {
      log('error', 'Uncaught exception', { error: error?.message || String(error), stack: error?.stack })
      process.exit(1)
    })

    process.on('unhandledRejection', (reason) => {
      log('error', 'Unhandled rejection', { reason })
      process.exit(1)
    })

    log('info', 'MCP Server ready')
  }
}

const isMain = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return import.meta.url === pathToFileURL(argv1).href
})()

if (isMain) {
  new MCPServer().start()
}

export default MCPServer
