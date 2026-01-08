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

type McpResourceSpec = {
  uri: string
  name: string
  description: string
  mimeType?: string
  getText: () => Promise<string> | string
}

type McpPromptArgument = {
  name: string
  description: string
  required?: boolean
}

type McpPromptSpec = {
  name: string
  description: string
  arguments?: McpPromptArgument[]
  getMessages: (args: Record<string, unknown>) => any[]
}

const ENV = process.env

const parseBool = (value: unknown): boolean => {
  const v = String(value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

type CliConfig = {
  karinUrl?: string
  waitReady?: boolean
  configRead?: boolean
  logLevel?: string
  readyTimeoutMs?: number
  readyPollMs?: number
  requestTimeoutMs?: number
  requestRetries?: number
  retryBackoffMs?: number
}

const parseCliConfig = (): CliConfig => {
  const cfg: CliConfig = {}
  const argv = process.argv.slice(2)

  const getValue = (raw: string, i: number) => {
    const eq = raw.indexOf('=')
    if (eq !== -1) return { value: raw.slice(eq + 1), next: i + 1 }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) return { value: next, next: i + 2 }
    return { value: '', next: i + 1 }
  }

  const setNum = (key: keyof CliConfig, value: string) => {
    const n = Number(value)
    if (Number.isFinite(n)) cfg[key] = n
  }

  for (let i = 0; i < argv.length;) {
    const raw = argv[i]
    if (!raw.startsWith('--')) {
      i += 1
      continue
    }

    const flag = raw.split('=')[0]
    switch (flag) {
      case '--karin-url': {
        const { value, next } = getValue(raw, i)
        if (value) cfg.karinUrl = value
        i = next
        continue
      }
      case '--wait-ready':
        cfg.waitReady = true
        i += 1
        continue
      case '--no-wait-ready':
        cfg.waitReady = false
        i += 1
        continue
      case '--config-read':
        cfg.configRead = true
        i += 1
        continue
      case '--no-config-read':
        cfg.configRead = false
        i += 1
        continue
      case '--log-level': {
        const { value, next } = getValue(raw, i)
        if (value) cfg.logLevel = value
        i = next
        continue
      }
      case '--quiet':
        cfg.logLevel = 'silent'
        i += 1
        continue
      case '--ready-timeout-ms': {
        const { value, next } = getValue(raw, i)
        setNum('readyTimeoutMs', value)
        i = next
        continue
      }
      case '--ready-poll-ms': {
        const { value, next } = getValue(raw, i)
        setNum('readyPollMs', value)
        i = next
        continue
      }
      case '--request-timeout-ms': {
        const { value, next } = getValue(raw, i)
        setNum('requestTimeoutMs', value)
        i = next
        continue
      }
      case '--request-retries': {
        const { value, next } = getValue(raw, i)
        setNum('requestRetries', value)
        i = next
        continue
      }
      case '--retry-backoff-ms': {
        const { value, next } = getValue(raw, i)
        setNum('retryBackoffMs', value)
        i = next
        continue
      }
      default:
        i += 1
        continue
    }
  }

  return cfg
}

const CLI = parseCliConfig()

const baseUrl = CLI.karinUrl
  ? CLI.karinUrl
  : ENV.KARIN_MCP_URL
  ? ENV.KARIN_MCP_URL
  : `${ENV.KARIN_BASE_URL || 'http://127.0.0.1:7777'}${ENV.KARIN_MCP_PATH || '/MCP'}`

const MCP_CONFIG = {
  name: 'karin-mcp',
  version: '1.5.0',
  description: 'Karin Bot MCP Server',
  karinUrl: baseUrl,
}

const MCP_FLAGS = {
  configRead: CLI.configRead ?? parseBool(ENV.KARIN_MCP_CONFIG_READ),
}

const LOG_LEVELS: Record<string, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const LOG_LEVEL = (() => {
  const v = String(CLI.logLevel ?? ENV.KARIN_MCP_LOG_LEVEL ?? '').trim().toLowerCase()
  if (!v) return 'error'
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, v) ? v : 'error'
})()

const canLog = (level: 'debug' | 'info' | 'warn' | 'error') => {
  const current = LOG_LEVELS[LOG_LEVEL] ?? 1
  const required = LOG_LEVELS[level] ?? 1
  return current >= required
}

const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data: unknown = null) => {
  if (!canLog(level)) return
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const toNum = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const MCP_HTTP = {
  waitReady: CLI.waitReady ?? (ENV.KARIN_MCP_WAIT_READY === undefined ? true : parseBool(ENV.KARIN_MCP_WAIT_READY)),
  readyTimeoutMs: clamp(toNum(CLI.readyTimeoutMs ?? ENV.KARIN_MCP_READY_TIMEOUT_MS, 30_000), 0, 5 * 60_000),
  readyPollMs: clamp(toNum(CLI.readyPollMs ?? ENV.KARIN_MCP_READY_POLL_MS, 500), 100, 5_000),
  requestTimeoutMs: clamp(toNum(CLI.requestTimeoutMs ?? ENV.KARIN_MCP_REQUEST_TIMEOUT_MS, 15_000), 250, 5 * 60_000),
  requestRetries: clamp(toNum(CLI.requestRetries ?? ENV.KARIN_MCP_REQUEST_RETRIES, 1), 0, 10),
  retryBackoffMs: clamp(toNum(CLI.retryBackoffMs ?? ENV.KARIN_MCP_RETRY_BACKOFF_MS, 400), 0, 10_000),
}

const parseJsonBestEffort = (text: string): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 2000) }
  }
}

const fetchTextWithTimeout = async (url: string, init: RequestInit, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text().catch(() => '')
    return { res, text }
  } finally {
    clearTimeout(timer)
  }
}

let lastHealthOkAt = 0

const waitForBridgeReady = async () => {
  if (!MCP_HTTP.waitReady) return

  // Avoid hammering health checks when multiple tool calls arrive close together.
  if (Date.now() - lastHealthOkAt < 1500) return

  const healthUrl = `${MCP_CONFIG.karinUrl}/health`
  const deadline = Date.now() + MCP_HTTP.readyTimeoutMs
  let lastError: unknown = null

  while (Date.now() <= deadline) {
    try {
      const { res, text } = await fetchTextWithTimeout(
        healthUrl,
        { method: 'GET' },
        clamp(Math.min(MCP_HTTP.requestTimeoutMs, 5_000), 250, 30_000),
      )

      if (res.ok) {
        lastHealthOkAt = Date.now()
        return
      }

      const body = parseJsonBestEffort(text)
      if (res.status === 410 && body && typeof body === 'object') {
        const error = String((body as any).error || '').trim()
        const activePath = String((body as any).activePath || '').trim()
        throw new Error(error || (activePath ? `MCP path changed, activePath=${activePath}` : 'MCP path changed'))
      }

      lastError = new Error(`Health check failed: HTTP ${res.status} ${res.statusText}`)
    } catch (error) {
      lastError = error
    }

    if (MCP_HTTP.readyTimeoutMs === 0) break
    await sleep(MCP_HTTP.readyPollMs)
  }

  const detail = lastError && typeof lastError === 'object' && 'message' in (lastError as any)
    ? String((lastError as any).message || '').trim()
    : String(lastError || '').trim()

  throw new Error(
    [
      `Karin MCP HTTP bridge not ready: ${healthUrl}`,
      `waited=${MCP_HTTP.readyTimeoutMs}ms`,
      detail ? `lastError=${detail}` : null,
    ].filter(Boolean).join(' '),
  )
}

const makeRequest = async (action: string, data: Record<string, unknown> = {}) => {
  const url = `${MCP_CONFIG.karinUrl}/api/${action}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  try {
    await waitForBridgeReady()
  } catch (error: any) {
    return {
      success: false,
      action,
      httpStatus: null,
      httpStatusText: '',
      error: error?.message || String(error),
      body: {
        karinUrl: MCP_CONFIG.karinUrl,
        healthUrl: `${MCP_CONFIG.karinUrl}/health`,
        hint: 'Start Karin first, or pass `--karin-url http://127.0.0.1:7777/MCP` (or set KARIN_MCP_URL).',
      },
    }
  }

  const maxAttempts = 1 + MCP_HTTP.requestRetries
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { res, text } = await fetchTextWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(data) },
        MCP_HTTP.requestTimeoutMs,
      )

      const body = parseJsonBestEffort(text)

      if (!res.ok) {
        const msg = (body && typeof body === 'object')
          ? String((body as any).error || (body as any).message || '').trim()
          : ''

        return {
          success: false,
          action,
          httpStatus: res.status,
          httpStatusText: res.statusText,
          error: msg || `HTTP ${res.status} ${res.statusText}`,
          body,
        }
      }

      return body
    } catch (error: any) {
      lastHealthOkAt = 0

      const msg = error?.name === 'AbortError'
        ? `Request timeout after ${MCP_HTTP.requestTimeoutMs}ms`
        : (error?.message || String(error))

      if (attempt >= maxAttempts) {
        return {
          success: false,
          action,
          httpStatus: null,
          httpStatusText: '',
          error: msg,
          body: {
            karinUrl: MCP_CONFIG.karinUrl,
            url,
            attempt,
            maxAttempts,
          },
        }
      }

      const backoff = MCP_HTTP.retryBackoffMs > 0 ? MCP_HTTP.retryBackoffMs * attempt : 0
      if (backoff) await sleep(backoff)

      try {
        await waitForBridgeReady()
      } catch {
        // ignore: next attempt will surface the final error
      }
    }
  }
}

const MCP_TOOLS: Record<string, McpToolSpec> = {
  bot_status: {
    name: 'bot_status',
    description: '获取 Karin 运行状态与 MCP 插件状态',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  'action.call': {
    name: 'action.call',
    description: '调用任意 HTTP action（白名单/权限由 Karin 端控制）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'HTTP action 名称（例如 bot.status）' },
        data: { type: 'object', description: '请求体 JSON（可选）' },
      },
      required: ['action'],
    },
  },
  'action.list': {
    name: 'action.list',
    description: '列出 Karin 端可用 actions（meta.actions）',
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
        file_type: { type: 'string', enum: ['auto', 'htmlString', 'vue3', 'vueString', 'react'], description: 'If file is HTML string, prefer htmlString (or omit for auto-detect).' },
        type: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        filename: { type: 'string' },
        return: { type: 'string', enum: ['url', 'filePath', 'both'] },
        echoFile: { type: 'boolean', description: 'Echo input file (truncated). Default false for low-token.' },
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

if (MCP_FLAGS.configRead) {
  MCP_TOOLS['status'] = {
    name: 'status',
    description: '获取 Karin/MCP 运行状态（等价于 bot_status）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }

  MCP_TOOLS['config.get'] = {
    name: 'config.get',
    description: '读取 Karin MCP 插件配置（只读）。需在 Karin 端开启 mcpTools.configRead',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }
}

// Low-token DX helpers (recommended tools for LLMs)
MCP_TOOLS.quick_status = {
  name: 'quick_status',
  description: 'Compact status summary (low token).',
  inputSchema: { type: 'object', properties: {}, required: [] },
}

MCP_TOOLS.send_message = {
  name: 'send_message',
  description: 'Send a test message (defaults user_id/nickname/waitMs; returns compact summary).',
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
    required: ['message'],
  },
}

MCP_TOOLS['scenario.list'] = {
  name: 'scenario.list',
  description: 'List builtin test scenarios (low token).',
  inputSchema: { type: 'object', properties: {}, required: [] },
}

MCP_TOOLS['scenario.run'] = {
  name: 'scenario.run',
  description: 'Run one builtin scenario (records JSON traces).',
  inputSchema: {
    type: 'object',
    properties: {
      scenarioId: { type: 'string' },
      sessionId: { type: 'string' },
      defaults: { type: 'object' },
    },
    required: ['scenarioId'],
  },
}

MCP_TOOLS['scenario.run_all'] = {
  name: 'scenario.run_all',
  description: 'Run all builtin scenarios (records JSON traces).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      defaults: { type: 'object' },
    },
    required: [],
  },
}

MCP_TOOLS['records.list'] = {
  name: 'records.list',
  description: 'List JSON test record files (http/sessions/traces).',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string' },
      limit: { type: 'number' },
    },
    required: [],
  },
}

MCP_TOOLS['records.tail'] = {
  name: 'records.tail',
  description: 'Tail JSONL test records for a date (kind=http|sessions).',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['http', 'sessions'] },
      date: { type: 'string' },
      limit: { type: 'number' },
      traceId: { type: 'string', description: 'Optional filter for kind=sessions' },
    },
    required: [],
  },
}

MCP_TOOLS['trace.get'] = {
  name: 'trace.get',
  description: 'Read a trace record (by date/file or traceId).',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string' },
      file: { type: 'string' },
      traceId: { type: 'string' },
    },
    required: [],
  },
}

const MCP_RESOURCES: Record<string, McpResourceSpec> = {
  'karin://mcp/overview.md': {
    uri: 'karin://mcp/overview.md',
    name: 'Karin MCP Overview',
    description: 'HTTP Bridge / MCP Server 基本信息与快速上手',
    mimeType: 'text/markdown',
    getText: () => {
      return [
        `# Karin MCP Bridge`,
        '',
        `- MCP(stdio) server: \`${MCP_CONFIG.name}@${MCP_CONFIG.version}\``,
        `- HTTP bridge: \`${MCP_CONFIG.karinUrl}\``,
        `- Auth: disabled (IP allowlist optional)`,
        '',
        '## HTTP endpoints',
        `- GET ${MCP_CONFIG.karinUrl}/health`,
        `- GET ${MCP_CONFIG.karinUrl}/files/:filename`,
        `- POST ${MCP_CONFIG.karinUrl}/api/bot.status`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.incoming.message`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.status`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.history`,
        `- POST ${MCP_CONFIG.karinUrl}/api/render.screenshot`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenarios.list`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenario.run`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenarios.runAll`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.records.list`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.records.tail`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.trace.get`,
        '',
        '## Notes',
        '- If `mcpPath` changes, the old path returns HTTP 410 with the new `activePath`.',
        '- JSON test logs are stored under `@karinjs/<plugin>/data/mcp-test` (http/sessions/traces/runs).',
        '- Recommended MCP tools: `quick_status`, `send_message`, `scenario.run_all`.',
        '- Chat commands are read-only: `#mcp 帮助` / `#mcp 配置` / `#mcp 状态` / `#mcp 导出配置`. For configuration changes, use Web UI (`web.config`).',
      ].join('\n')
    },
  },
  'karin://mcp/ide-snippet.json': {
    uri: 'karin://mcp/ide-snippet.json',
    name: 'IDE Client Snippet',
    description: '示例：给 MCP Host 的环境变量片段（按你的宿主格式调整）',
    mimeType: 'application/json',
    getText: () => JSON.stringify({
      command: 'node',
      args: [
        process.argv[1] || 'path/to/mcp-server.js',
        '--karin-url',
        MCP_CONFIG.karinUrl,
        MCP_FLAGS.configRead ? '--config-read' : '--no-config-read',
      ],
    }, null, 2),
  },
  'karin://mcp/troubleshooting.md': {
    uri: 'karin://mcp/troubleshooting.md',
    name: 'Troubleshooting',
    description: '常见问题排查：403/410/无回复/渲染失败',
    mimeType: 'text/markdown',
    getText: () => [
      '# Troubleshooting',
      '',
      '## 403 Forbidden (IP allowlist)',
      '- Your IP is not in allowlist. Check `security.ipAllowlist` in Web UI config.',
      '',
      '## 410 Gone (mcpPath changed)',
      '- Your configured URL is outdated. Use the `activePath` returned by the 410 response, or check `#mcp 配置`.',
      '',
      '## No reply / empty responses',
      '- Try `quick_status` (or `bot_status`) to confirm plugin is alive.',
      '- Use `send_message` (or `mock_incoming_message`) with a new `traceId` and increase `waitMs`.',
      '',
      '## Render failures',
      '- `render_screenshot` accepts URL/local path/HTML string; try `file_type=htmlString` for inline HTML.',
    ].join('\n'),
  },
}

const MCP_PROMPTS: Record<string, McpPromptSpec> = {
  inject_message: {
    name: 'inject_message',
    description: '注入一条消息到 Karin（send_message），并解释 traceId/聚合回复用法',
    arguments: [
      { name: 'message', description: '要发送的内容', required: true },
      { name: 'user_id', description: 'user_id（可选；留空使用默认）' },
      { name: 'group_id', description: '群 ID（可选；传了就视为群聊）' },
    ],
    getMessages: (args) => {
      const message = String(args.message || '').trim()
      const userId = String(args.user_id || '').trim()
      const groupId = String(args.group_id || '').trim()
      const payload = {
        message,
        user_id: userId || undefined,
        group_id: groupId || undefined,
        waitMs: 1200,
      }
      return [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '请使用 `send_message` 工具把下面这条消息注入 Karin，并根据返回的 `replies/traceId` 汇总回复。',
                '',
                '提示：',
                '- user_id 可以不传，工具会填默认值。',
                '- traceId 可以不传，让服务端自动生成。',
                '- 如果回复较慢，可以把 waitMs 提高到 3000-8000。',
                '- 需要结构化消息段（图片/卡片等）时，使用返回的 `messages`（elements JSON）。',
                '- 历史会话默认不回传：用 `records.tail`（kind=sessions, traceId=...）自行查询。',
                '',
                `参数：\n${JSON.stringify(payload, null, 2)}`,
              ].join('\n'),
            },
          ],
        },
      ]
    },
  },
  debug_auth_path: {
    name: 'debug_auth_path',
    description: '排查 IP 白名单与 mcpPath 变更（403/410）',
    getMessages: () => [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '请按以下步骤排查：',
              `1) 调用 quick_status（或 bot_status）确认服务可用；`,
              `2) 如果出现 403：检查 Web UI 配置 security.ipAllowlist（IP/CIDR 白名单）；`,
              `3) 如果出现 410：说明 mcpPath 已变更，使用响应中的 activePath 更新你的 URL；`,
              `4) 如仍失败，尝试在 Karin 聊天中发送：#mcp 配置 / #mcp 状态 查看实时信息。`,
            ].join('\n'),
          },
        ],
      },
    ],
  },
}

const toSafeLogData = (value: unknown, keyHint = ''): unknown => {
  const key = keyHint.toLowerCase()
  if (typeof value === 'string') {
    if (key.includes('apikey')) return '[redacted]'
    if (value.length > 200) return `${value.slice(0, 200)}…`
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => toSafeLogData(v))
  }

  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toSafeLogData(v, k)
    }
    return obj
  }

  return value
}

const executeTool = async (name: string, args: Record<string, unknown> | undefined) => {
  log('info', `Executing tool: ${name}`, args ? toSafeLogData(args) : null)

  const asStr = (value: unknown) => String(value ?? '').trim()
  const asNum = (value: unknown, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  const compactStatus = (result: any) => {
    if (!result || typeof result !== 'object') return result
    if (result.success === false) return result
    const d = result.data ?? {}
    return {
      success: true,
      action: result.action || 'bot.status',
      data: {
        mcpPath: d?.mcpPath ?? null,
        mcpServer: d?.mcpServer ?? null,
        adapter: d?.adapter ?? null,
        buffers: d?.buffers ?? null,
      },
      time: result.time ?? Date.now(),
    }
  }

  const compactIncoming = (result: any) => {
    if (!result || typeof result !== 'object') return result
    if (result.success === false) return result
    const d = result.data ?? {}
    const responses = Array.isArray(d?.responses) ? d.responses : []
    const replies = responses
      .map((r: any) => asStr(r?.msg))
      .filter(Boolean)
      .slice(0, 8)

    const messages = responses
      .slice(0, 8)
      .map((r: any) => ({
        time: r?.time ?? null,
        messageId: r?.messageId ?? null,
        kind: r?.kind ?? null,
        msg: asStr(r?.msg) || null,
        elements: toSafeLogData(r?.elements, 'elements'),
      }))

    return {
      success: true,
      action: result.action || 'mock.incoming.message',
      data: {
        traceId: d?.traceId ?? null,
        replyCount: responses.length,
        replies,
        messages,
        traceFile: d?.traceFile ?? null,
        sessionFile: d?.sessionFile ?? null,
      },
      time: result.time ?? Date.now(),
    }
  }

  const compactScenarioRun = (result: any) => {
    if (!result || typeof result !== 'object') return result
    if (result.success === false) return result
    const d = result.data ?? {}
    const steps = Array.isArray(d?.steps) ? d.steps : []
    const failed = steps.filter((s: any) => s && s.ok === false).slice(0, 6).map((s: any) => ({
      name: s?.name ?? null,
      target: s?.target ?? null,
      status: s?.status ?? null,
      error: s?.error ?? null,
    }))
    return {
      success: true,
      action: result.action,
      data: {
        sessionId: d?.sessionId ?? null,
        scenarioId: d?.scenarioId ?? null,
        title: d?.title ?? null,
        ok: d?.ok ?? null,
        durationMs: d?.durationMs ?? null,
        stepCount: steps.length,
        failed,
        runFile: d?.runFile ?? null,
      },
      time: result.time ?? Date.now(),
    }
  }

  const compactScenarioSuite = (result: any) => {
    if (!result || typeof result !== 'object') return result
    if (result.success === false) return result
    const d = result.data ?? {}
    const scenarios = Array.isArray(d?.scenarios) ? d.scenarios : []
    const failed = scenarios.filter((s: any) => s && s.ok === false).slice(0, 10).map((s: any) => s?.scenarioId ?? null)
    return {
      success: true,
      action: result.action,
      data: {
        sessionId: d?.sessionId ?? null,
        ok: d?.ok ?? null,
        durationMs: d?.durationMs ?? null,
        scenarioCount: scenarios.length,
        failed,
        runFile: d?.runFile ?? null,
      },
      time: result.time ?? Date.now(),
    }
  }

  switch (name) {
    case 'bot_status':
      return await makeRequest('bot.status')
    case 'status':
      return await makeRequest('bot.status')
    case 'quick_status':
      return compactStatus(await makeRequest('bot.status'))
    case 'action.call': {
      const action = String((args as any)?.action || '').trim()
      if (!action) throw new Error('action.call: action is required')
      const data = ((args as any)?.data && typeof (args as any).data === 'object') ? (args as any).data : {}
      return await makeRequest(action, data)
    }
    case 'action.list':
      return await makeRequest('meta.actions')
    case 'scenario.list':
      return await makeRequest('test.scenarios.list')
    case 'scenario.run': {
      const scenarioId = asStr((args as any)?.scenarioId || (args as any)?.id)
      if (!scenarioId) throw new Error('scenario.run: scenarioId is required')
      const sessionId = asStr((args as any)?.sessionId) || undefined
      const defaults = ((args as any)?.defaults && typeof (args as any).defaults === 'object') ? (args as any).defaults : undefined
      return compactScenarioRun(await makeRequest('test.scenario.run', { scenarioId, sessionId, defaults }))
    }
    case 'scenario.run_all': {
      const sessionId = asStr((args as any)?.sessionId) || undefined
      const defaults = ((args as any)?.defaults && typeof (args as any).defaults === 'object') ? (args as any).defaults : undefined
      return compactScenarioSuite(await makeRequest('test.scenarios.runAll', { sessionId, defaults }))
    }
    case 'records.list': {
      const date = asStr((args as any)?.date) || undefined
      const limit = asNum((args as any)?.limit, 50)
      return await makeRequest('test.records.list', { date, limit })
    }
    case 'records.tail': {
      const date = asStr((args as any)?.date) || undefined
      const limit = asNum((args as any)?.limit, 20)
      const kind = asStr((args as any)?.kind) || undefined
      const traceId = asStr((args as any)?.traceId) || undefined
      return await makeRequest('test.records.tail', { kind, date, limit, traceId })
    }
    case 'trace.get': {
      const date = asStr((args as any)?.date) || undefined
      const file = asStr((args as any)?.file) || undefined
      const traceId = asStr((args as any)?.traceId) || undefined
      return await makeRequest('test.trace.get', { date, file, traceId })
    }
    case 'send_message': {
      const message = asStr((args as any)?.message)
      if (!message) throw new Error('send_message: message is required')

      const payload: Record<string, unknown> = {
        message,
        user_id: asStr((args as any)?.user_id) || 'mcp-test-user',
        group_id: asStr((args as any)?.group_id) || undefined,
        nickname: asStr((args as any)?.nickname) || 'MCP Tester',
        role: asStr((args as any)?.role) || 'member',
        waitMs: asNum((args as any)?.waitMs, 1200),
        traceId: asStr((args as any)?.traceId) || crypto.randomUUID(),
      }

      return compactIncoming(await makeRequest('mock.incoming.message', payload))
    }
    case 'mock_incoming_message':
      return await makeRequest('mock.incoming.message', args || {})
    case 'mock_status':
      return await makeRequest('mock.status')
    case 'mock_history':
      return await makeRequest('mock.history', args || {})
    case 'render_screenshot':
      return await makeRequest('render.screenshot', args || {})
    case 'config.get':
      return await makeRequest('config.get')
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
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
      serverInfo: { name: MCP_CONFIG.name, version: MCP_CONFIG.version },
    })
    // Per MCP handshake: the client sends `notifications/initialized` after
    // receiving the initialize response. The server should not send (or respond
    // to) that notification.
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
        content: [{ type: 'text', text: JSON.stringify(result) }],
      })
    } catch (error: any) {
      this.sendResponse(id, null, { code: -32000, message: error?.message || String(error) })
    }
  }

  async handleListResources (id: unknown) {
    const resources = Object.values(MCP_RESOURCES).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }))
    this.sendResponse(id, { resources })
  }

  async handleReadResource (id: unknown, params: any) {
    try {
      const uri = String(params?.uri || '').trim()
      const spec = MCP_RESOURCES[uri]
      if (!spec) throw new Error(`Resource not found: ${uri}`)

      const text = await spec.getText()
      this.sendResponse(id, {
        contents: [
          {
            uri: spec.uri,
            mimeType: spec.mimeType || 'text/plain',
            text,
          },
        ],
      })
    } catch (error: any) {
      this.sendResponse(id, null, { code: -32000, message: error?.message || String(error) })
    }
  }

  async handleListPrompts (id: unknown) {
    const prompts = Object.values(MCP_PROMPTS).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments || [],
    }))
    this.sendResponse(id, { prompts })
  }

  async handleGetPrompt (id: unknown, params: any) {
    try {
      const name = String(params?.name || '').trim()
      const args = (params?.arguments && typeof params.arguments === 'object') ? (params.arguments as Record<string, unknown>) : {}
      const spec = MCP_PROMPTS[name]
      if (!spec) throw new Error(`Prompt not found: ${name}`)

      const messages = spec.getMessages(args)
      this.sendResponse(id, { description: spec.description, messages })
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
        case 'notifications/initialized':
          // Client -> server notification (no response).
          this.initialized = true
          break
        case 'tools/list':
          await this.handleListTools(id)
          break
        case 'tools/call':
          await this.handleCallTool(id, params)
          break
        case 'resources/list':
          await this.handleListResources(id)
          break
        case 'resources/read':
          await this.handleReadResource(id, params)
          break
        case 'prompts/list':
          await this.handleListPrompts(id)
          break
        case 'prompts/get':
          await this.handleGetPrompt(id, params)
          break
        default:
          // Only requests (with id) should get a response. Ignore unknown notifications.
          if (id !== undefined && id !== null) {
            this.sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` })
          }
      }
    } catch (error: any) {
      log('error', 'Message handling failed', { error: error?.message || String(error), message })
      if (message?.id !== undefined && message?.id !== null) {
        this.sendResponse(message.id, null, { code: -32000, message: error?.message || String(error) })
      }
    }
  }

  start () {
    log('info', 'MCP Server starting', { ...MCP_CONFIG })

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
