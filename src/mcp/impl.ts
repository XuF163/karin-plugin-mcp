import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Request, Response } from 'express'

import {
  contactFriend,
  contactGroup,
  createFriendMessage,
  createGroupMessage,
  fileToUrl,
  getAllBot,
  logger,
  registerBot,
  render,
  senderFriend,
  senderGroup,
  segment,
  unregisterBot,
} from 'node-karin'

import { dir } from '../dir'
import { getMcpPluginConfig } from '../utils/config'
import { getTraceRecord, listTestRecords, recordHttp, recordSession, tailHttpLog, tailSessionLog, writeTraceRecord } from '../testing/records'
import { runTestScenario, runTestScenarioSuite } from '../testing/runner'
import { TEST_SCENARIOS, getTestScenario, listTestScenarios } from '../testing/scenarios'
import { authorizeRequest } from './auth'
import { getLocalBaseUrl } from './baseUrl'
import { McpAdapter, type TraceEntry } from './adapter/mcpAdapter'
import { getMcpAction, listMcpActions, validateInputSchema } from './registry'
import { clamp, sleep, toNum, toStr } from './utils'

type TraceStore = { traceId: string }

export interface CreateMcpImplOptions {
  mcpPath: string
  pluginName: string
  /**
   * Best-effort reload hook used by HTTP config actions.
   * We keep it optional to avoid coupling createMcpImpl() to init.ts directly.
   */
  reloadPlugin?: (next: { mcpPath: string }) => Promise<void>
}

export interface McpImpl {
  handleHealth: (req: Request, res: Response) => void
  handleApi: (req: Request, res: Response) => Promise<void>
  handleFile: (req: Request, res: Response) => void
  dispose: () => Promise<void>
}

const resolveMcpServerLaunch = (): { args: string[], cwd: string } => {
  const pluginDir = dir.pluginDir
  const distPath = path.join(pluginDir, 'lib', 'mcp-server.js')
  if (existsSync(distPath)) return { args: [distPath], cwd: pluginDir }

  const srcPath = path.join(pluginDir, 'src', 'mcp-server.ts')
  return { args: ['--import', 'tsx', srcPath], cwd: pluginDir }
}

export const createMcpImpl = (options: CreateMcpImplOptions): McpImpl => {
  const { mcpPath, pluginName } = options

  const traceStorage = new AsyncLocalStorage<TraceStore>()
  const traces = new Map<string, TraceEntry>()
  const inbox: any[] = []
  const outbox: any[] = []

  const pluginConfig = getMcpPluginConfig()
  const maxHistory = pluginConfig.runtime.maxHistory
  const traceTtlMs = pluginConfig.runtime.traceTtlMs
  const renderDir = path.join(dir.karinPath, 'data', 'mcp-render')
  let fileToUrlMissingHandlerLogged = false

  const authOptions = {
    ipAllowlist: pluginConfig.security?.ipAllowlist || [],
  }

  const ACTION_SCOPES: Record<string, string[]> = {
    'bot.status': ['status'],
    'mock.status': ['mock'],
    'mock.history': ['mock'],
    'mock.incoming.message': ['mock'],
    'render.screenshot': ['render'],
    'config.get': ['config:read'],
    'test.records.list': ['test'],
    'test.records.tail': ['test'],
    'test.trace.get': ['test'],
    'test.scenarios.list': ['test'],
    'test.scenario.run': ['test'],
    'test.scenarios.runAll': ['test'],
    'meta.actions': ['meta'],
  }

  type RateBucket = { tokens: number, lastRefillMs: number, concurrent: number }
  const userBuckets = new Map<string, RateBucket>()
  const groupBuckets = new Map<string, RateBucket>()

  const acquireRateLimit = (map: Map<string, RateBucket>, key: string, rule: { maxConcurrent: number, rps: number, burst: number }) => {
    const now = Date.now()

    const bucket: RateBucket = map.get(key) ?? { tokens: rule.burst, lastRefillMs: now, concurrent: 0 }

    // Refill token bucket.
    const elapsedMs = now - bucket.lastRefillMs
    if (elapsedMs > 0 && rule.rps > 0) {
      bucket.tokens = Math.min(rule.burst, bucket.tokens + (elapsedMs * rule.rps) / 1000)
    }
    bucket.lastRefillMs = now

    if (bucket.concurrent >= rule.maxConcurrent) {
      map.set(key, bucket)
      return { ok: false as const, reason: 'concurrent', retryAfterMs: 500 }
    }

    if (rule.rps > 0 && bucket.tokens < 1) {
      map.set(key, bucket)
      const retryAfterMs = Math.max(100, Math.ceil(((1 - bucket.tokens) / rule.rps) * 1000))
      return { ok: false as const, reason: 'rate', retryAfterMs }
    }

    if (rule.rps > 0) bucket.tokens -= 1
    bucket.concurrent += 1
    map.set(key, bucket)

    const release = () => {
      const current = map.get(key)
      if (!current) return
      current.concurrent = Math.max(0, current.concurrent - 1)

      // Best-effort cleanup for inactive keys to avoid unbounded growth.
      if (current.concurrent === 0 && Date.now() - current.lastRefillMs > 10 * 60 * 1000) {
        map.delete(key)
      } else {
        map.set(key, current)
      }
    }

    return { ok: true as const, release }
  }

  let mcpProcess: ChildProcessWithoutNullStreams | null = null
  let adapter: McpAdapter | null = null
  let adapterIndex: number | null = null

  const startMcpServerProcess = () => {
    if (mcpProcess) return

    const baseUrl = getLocalBaseUrl()
    const mcpUrl = `${baseUrl}${mcpPath}`
    const { args, cwd } = resolveMcpServerLaunch()

    try {
      mcpProcess = spawn(process.execPath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          KARIN_BASE_URL: baseUrl,
          KARIN_MCP_PATH: mcpPath,
          KARIN_MCP_URL: mcpUrl,
          KARIN_MCP_CONFIG_READ: pluginConfig.mcpTools?.configRead ? '1' : '0',
        },
      })

      mcpProcess.stdout.on('data', (data) => {
        const text = data.toString().trim()
        if (text) logger.debug(`[${pluginName} mcp-server] stdout: ${text}`)
      })

      mcpProcess.stderr.on('data', (data) => {
        const text = data.toString()
        text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            try {
              const entry = JSON.parse(line)
              const level = toStr(entry.level || 'info').toLowerCase()
              const msg = toStr(entry.message || line)
              if (level === 'error') logger.error(`[${pluginName} mcp-server] ${msg}`)
              else if (level === 'warn') logger.warn(`[${pluginName} mcp-server] ${msg}`)
              else logger.info(`[${pluginName} mcp-server] ${msg}`)
            } catch {
              logger.debug(`[${pluginName} mcp-server] stderr: ${line}`)
            }
          })
      })

      mcpProcess.on('close', (code) => {
        logger.warn(`[${pluginName}] mcp-server exited: ${code}`)
        mcpProcess = null
      })

      mcpProcess.on('error', (error) => {
        logger.error(`[${pluginName}] mcp-server error: ${error?.message || error}`)
        mcpProcess = null
      })

      logger.mark(`[${pluginName}] mcp-server spawned (pid=${mcpProcess.pid})`)
    } catch (error: any) {
      logger.error(`[${pluginName}] spawn mcp-server failed: ${error?.message || error}`)
      mcpProcess = null
    }
  }

  const stopMcpServerProcess = async () => {
    if (!mcpProcess) return
    try {
      mcpProcess.kill('SIGTERM')
    } catch {
      // ignore
    } finally {
      mcpProcess = null
    }
  }

  const registerAdapter = () => {
    adapter = new McpAdapter({ traceStorage, traces, inbox, outbox, maxHistory })
    adapterIndex = registerBot('other', adapter as any)
    logger.mark(`[${pluginName}] adapter registered: selfId=${adapter.selfId}, index=${adapterIndex}`)
  }

  const unregisterAdapter = () => {
    if (!adapter) return
    try {
      unregisterBot('selfId', adapter.selfId)
    } catch (error: any) {
      logger.debug(`[${pluginName}] unregisterBot failed: ${error?.message || error}`)
    } finally {
      adapter = null
      adapterIndex = null
    }
  }

  const handleHealth = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      plugin: pluginName,
      mcpPath,
      time: Date.now(),
      mcpServer: {
        running: Boolean(mcpProcess),
        pid: mcpProcess?.pid ?? null,
      },
      adapter: {
        selfId: adapter?.selfId ?? null,
        index: adapterIndex,
      },
    })
  }

  const handleFile = (req: Request, res: Response) => {
    const auth = authorizeRequest(req, authOptions)
    if (!auth.ok) {
      res.status(auth.status).json({ success: false, error: auth.error || 'Unauthorized' })
      return
    }

    const filename = toStr((req.params as any)?.filename).trim()
    if (!filename) {
      res.status(400).json({ success: false, error: 'filename 不能为空' })
      return
    }

    const safe = path.basename(filename)
    if (safe !== filename) {
      res.status(400).json({ success: false, error: 'filename 非法' })
      return
    }

    const filePath = path.join(renderDir, safe)
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'file not found' })
      return
    }

    res.sendFile(filePath)
  }

  const toPublicConfig = (cfg: any) => cfg

  const handleApi = async (req: Request, res: Response) => {
    const startedAt = Date.now()
    const requestId = crypto.randomUUID()
    const method = toStr(req.method).trim() || 'POST'
    const ip = toStr((req as any).ip).trim()
    let reqData: any = null

    const action = toStr((req.params as any)?.action).trim()
    const extAction = getMcpAction(action)
    const auth = authorizeRequest(req, authOptions)
    if (!auth.ok) {
      const body = { success: false, action, error: auth.error || 'Unauthorized' }
      recordHttp({
        id: requestId,
        time: startedAt,
        action,
        method,
        ip,
        status: auth.status,
        ok: false,
        durationMs: Date.now() - startedAt,
        request: null,
        responseSummary: { error: body.error },
      })
      res.status(auth.status).json(body)
      return
    }

    const data = req.method === 'GET' ? (req.query as any) : (req.body as any)
    reqData = data

    const summarizeResponse = (body: any) => {
      if (!body || typeof body !== 'object') return body
      if (body.success === false) return { success: false, error: toStr(body.error || '').trim() || undefined }

      const d = body.data ?? null
      if (action === 'mock.incoming.message') {
        const responses = Array.isArray(d?.responses) ? d.responses : []
        const replies = responses
          .map((r: any) => toStr(r?.msg || '').trim())
          .filter(Boolean)
          .slice(0, 10)
        return { traceId: d?.traceId || null, replies, replyCount: responses.length }
      }
      if (action === 'render.screenshot') {
        const results = Array.isArray(d?.results) ? d.results : []
        return {
          type: d?.type || null,
          count: results.length,
          results: results.slice(0, 10).map((r: any) => ({
            filename: r?.filename ?? null,
            url: r?.url ?? null,
            filePath: r?.filePath ?? null,
            width: r?.width ?? null,
            height: r?.height ?? null,
          })),
        }
      }
      if (action === 'bot.status') {
        return {
          mcpPath: d?.mcpPath ?? null,
          mcpServer: d?.mcpServer ?? null,
          adapter: d?.adapter ?? null,
          buffers: d?.buffers ?? null,
        }
      }
      if (action === 'test.records.list') {
        const http = Array.isArray(d?.http) ? d.http : []
        const sessions = Array.isArray(d?.sessions) ? d.sessions : []
        const traces = Array.isArray(d?.traces) ? d.traces : []
        return {
          baseDir: d?.baseDir ?? null,
          httpCount: http.length,
          sessionCount: sessions.length,
          traceCount: traces.length,
          latestHttp: http[0]?.file ?? null,
          latestSession: sessions[0]?.file ?? null,
          latestTrace: traces[0] ? { date: traces[0]?.date ?? null, file: traces[0]?.file ?? null } : null,
        }
      }
      if (action === 'test.records.tail') {
        const items = Array.isArray(d?.items) ? d.items : []
        const kind = toStr(d?.kind).trim() || 'http'
        const tail = items.slice(-3).map((it: any) => {
          if (kind === 'sessions') {
            const responses = Array.isArray(it?.responses) ? it.responses : []
            return {
              time: it?.time ?? null,
              action: it?.action ?? null,
              traceId: it?.traceId ?? null,
              responseCount: responses.length,
            }
          }
          return {
            time: it?.time ?? null,
            action: it?.action ?? null,
            status: it?.status ?? null,
            ok: it?.ok ?? null,
            traceId: it?.traceId ?? null,
          }
        })
        return { kind, date: d?.date ?? null, count: items.length, tail }
      }
      if (action === 'test.trace.get') {
        const record = d?.data ?? null
        const responses = Array.isArray(record?.responses) ? record.responses : []
        return {
          date: d?.date ?? null,
          file: d?.file ?? null,
          traceId: record?.traceId ?? null,
          responseCount: responses.length,
        }
      }
      if (action === 'test.scenarios.list') {
        const scenarios = Array.isArray(d?.scenarios) ? d.scenarios : []
        return { count: scenarios.length, scenarios: scenarios.slice(0, 50).map((s: any) => s?.id ?? null) }
      }
      if (action === 'test.scenario.run') {
        const steps = Array.isArray(d?.steps) ? d.steps : []
        return {
          sessionId: d?.sessionId ?? null,
          scenarioId: d?.scenarioId ?? null,
          ok: d?.ok ?? null,
          durationMs: d?.durationMs ?? null,
          stepCount: steps.length,
          runFile: d?.runFile ?? null,
        }
      }
      if (action === 'test.scenarios.runAll') {
        const scenarios = Array.isArray(d?.scenarios) ? d.scenarios : []
        const failed = scenarios.filter((s: any) => s && s.ok === false).slice(0, 10).map((s: any) => s?.scenarioId ?? null)
        return {
          sessionId: d?.sessionId ?? null,
          ok: d?.ok ?? null,
          durationMs: d?.durationMs ?? null,
          scenarioCount: scenarios.length,
          failed,
          runFile: d?.runFile ?? null,
        }
      }

      return d
    }

    const replyJson = (status: number, body: any) => {
      const traceId = toStr(body?.data?.traceId || reqData?.traceId || '').trim() || undefined
      recordHttp({
        id: requestId,
        time: startedAt,
        action,
        method,
        ip,
        status,
        ok: Boolean(body?.success),
        durationMs: Date.now() - startedAt,
        traceId,
        request: reqData,
        responseSummary: summarizeResponse(body),
      })
      res.status(status).json(body)
    }

    try {
      switch (action) {
        case 'config.get': {
          const cfg = getMcpPluginConfig()
          if (!cfg.mcpTools?.configRead) {
            replyJson(403, { success: false, action, error: 'MCP config tools disabled (enable mcpTools.configRead in config/web)' })
            return
          }

          replyJson(200, {
            success: true,
            action,
            data: {
              config: toPublicConfig(cfg),
            },
            time: Date.now(),
          })
          return
        }

        case 'meta.actions': {
          const extra = listMcpActions().map((a) => ({
            name: a.name,
            kind: 'extension',
            description: a.description,
            scopes: a.scopes?.length ? a.scopes : ['ext'],
            inputSchema: a.inputSchema || null,
          }))

          const builtinMeta: Record<string, { description: string, inputSchema?: any, enabled?: boolean }> = {
            'bot.status': { description: 'Karin 与插件运行状态' },
            'mock.incoming.message': { description: '注入入站消息并按 traceId 聚合回复' },
            'mock.status': { description: 'Mock 环境统计（inbox/outbox/trace 数量）' },
            'mock.history': { description: 'Mock 收发历史（in/out）' },
            'render.screenshot': { description: '截图渲染（返回 url/filePath）' },
            'config.get': {
              description: '读取插件配置（只读）',
              enabled: Boolean(pluginConfig.mcpTools?.configRead),
            },
            'test.records.list': { description: 'List JSON test record files (http log + traces)' },
            'test.records.tail': { description: 'Tail HTTP JSONL test records for a date' },
            'test.trace.get': { description: 'Read a trace record by date/file or traceId' },
            'test.scenarios.list': { description: 'List builtin test scenarios' },
            'test.scenario.run': { description: 'Run one test scenario (recording JSON traces)' },
            'test.scenarios.runAll': { description: 'Run all builtin test scenarios (recording JSON traces)' },
            'meta.actions': { description: '列出可用 HTTP actions（本接口）' },
          }

          const builtins = Object.entries(ACTION_SCOPES).map(([name, scopes]) => ({
            name,
            kind: 'builtin',
            description: builtinMeta[name]?.description || '',
            scopes,
            enabled: builtinMeta[name]?.enabled ?? true,
            inputSchema: builtinMeta[name]?.inputSchema || null,
          }))

          replyJson(200, {
            success: true,
            action,
            data: {
              actions: [...builtins, ...extra].sort((a, b) => a.name.localeCompare(b.name)),
            },
            time: Date.now(),
          })
          return
        }

        case 'bot.status': {
          replyJson(200, {
            success: true,
            action,
            data: {
              plugin: pluginName,
              mcpPath,
              http: { baseUrl: getLocalBaseUrl() },
              runtime: {
                maxHistory,
                traceTtlMs,
              },
              artifacts: pluginConfig.artifacts,
              limits: pluginConfig.limits,
              mcpServer: {
                running: Boolean(mcpProcess),
                pid: mcpProcess?.pid ?? null,
              },
              adapter: {
                selfId: adapter?.selfId ?? null,
                index: adapterIndex,
              },
              buffers: {
                traces: traces.size,
                inbox: inbox.length,
                outbox: outbox.length,
              },
              rateLimit: {
                userKeys: userBuckets.size,
                groupKeys: groupBuckets.size,
              },
              bots: getAllBot().map((bot) => ({ selfId: bot.selfId, adapter: bot.adapter?.name })),
            },
            time: Date.now(),
          })
          return
        }

        case 'mock.status': {
          replyJson(200, {
            success: true,
            action,
            data: {
              traces: traces.size,
              inbox: inbox.length,
              outbox: outbox.length,
            },
            time: Date.now(),
          })
          return
        }

        case 'mock.history': {
          const type = toStr(data?.type).trim()
          const limit = clamp(toNum(data?.limit, 50), 1, 200)
          const pick = (arr: any[]) => arr.slice(0, limit)
          replyJson(200, {
            success: true,
            action,
            data:
              type === 'in'
                ? { inbox: pick(inbox) }
                : type === 'out'
                ? { outbox: pick(outbox) }
                : { inbox: pick(inbox), outbox: pick(outbox) },
            time: Date.now(),
          })
          return
        }

        case 'test.records.list': {
          const limit = clamp(toNum(data?.limit, 50), 1, 200)
          const date = toStr(data?.date).trim() || undefined
          replyJson(200, {
            success: true,
            action,
            data: listTestRecords({ date, limit }),
            time: Date.now(),
          })
          return
        }

        case 'test.records.tail': {
          const limit = clamp(toNum(data?.limit, 20), 1, 200)
          const date = toStr(data?.date).trim() || undefined
          const kind = toStr((data as any)?.kind || (data as any)?.type).trim().toLowerCase() || 'http'
          const traceId = toStr((data as any)?.traceId).trim() || undefined

          const normalizedKind = (kind === 'session' || kind === 'sessions') ? 'sessions' : 'http'
          const result = normalizedKind === 'sessions'
            ? tailSessionLog({ date, limit, traceId })
            : tailHttpLog({ date, limit })
          replyJson(200, {
            success: true,
            action,
            data: { kind: normalizedKind, ...result },
            time: Date.now(),
          })
          return
        }

        case 'test.trace.get': {
          const date = toStr(data?.date).trim() || undefined
          const file = toStr(data?.file).trim() || undefined
          const traceId = toStr(data?.traceId).trim() || undefined
          replyJson(200, {
            success: true,
            action,
            data: getTraceRecord({ date, file, traceId }),
            time: Date.now(),
          })
          return
        }

        case 'test.scenarios.list': {
          replyJson(200, {
            success: true,
            action,
            data: {
              scenarios: listTestScenarios(),
            },
            time: Date.now(),
          })
          return
        }

        case 'test.scenario.run': {
          const scenarioId = toStr(data?.scenarioId || data?.id).trim()
          const scenario = getTestScenario(scenarioId)
          if (!scenario) {
            replyJson(404, { success: false, action, error: `Unknown scenario: ${scenarioId}` })
            return
          }

          const sessionId = toStr(data?.sessionId).trim() || undefined
          const defaults = (data?.defaults && typeof data.defaults === 'object') ? (data.defaults as Record<string, unknown>) : undefined
          const mcpUrl = `${getLocalBaseUrl()}${mcpPath}`

          const result = await runTestScenario({ mcpUrl, scenario, sessionId, defaults })
          replyJson(200, { success: true, action, data: result, time: Date.now() })
          return
        }

        case 'test.scenarios.runAll': {
          const sessionId = toStr(data?.sessionId).trim() || undefined
          const defaults = (data?.defaults && typeof data.defaults === 'object') ? (data.defaults as Record<string, unknown>) : undefined
          const mcpUrl = `${getLocalBaseUrl()}${mcpPath}`

          const result = await runTestScenarioSuite({ mcpUrl, scenarios: TEST_SCENARIOS, sessionId, defaults })
          replyJson(200, { success: true, action, data: result, time: Date.now() })
          return
        }

        case 'mock.incoming.message': {
          if (!adapter) throw new Error('MCP adapter not ready')

          const message = toStr(data?.message)
          const userId = toStr(data?.user_id).trim()
          const groupId = toStr(data?.group_id).trim()
          const nickname = toStr(data?.nickname).trim()
          const role = toStr(data?.role).trim() || 'member'
          const waitMs = clamp(toNum(data?.waitMs, 1200), 0, 60_000)
          const traceId = toStr(data?.traceId).trim() || crypto.randomUUID()

          if (!message) throw new Error('message 不能为空')
          if (!userId) throw new Error('user_id 不能为空')

          const releases: Array<() => void> = []
          if (pluginConfig.limits.enabled) {
            const userBucket = acquireRateLimit(userBuckets, userId, pluginConfig.limits.perUser)
            if (!userBucket.ok) {
              replyJson(429, {
                success: false,
                action,
                error: `Rate limited (${userBucket.reason}) for user_id=${userId}`,
                retryAfterMs: userBucket.retryAfterMs,
              })
              return
            }
            releases.push(userBucket.release)

            if (groupId) {
              const groupBucket = acquireRateLimit(groupBuckets, groupId, pluginConfig.limits.perGroup)
              if (!groupBucket.ok) {
                releases.forEach((fn) => fn())
                replyJson(429, {
                  success: false,
                  action,
                  error: `Rate limited (${groupBucket.reason}) for group_id=${groupId}`,
                  retryAfterMs: groupBucket.retryAfterMs,
                })
                return
              }
              releases.push(groupBucket.release)
            }
          }

          try {
            const now = Date.now()
            const messageSeq = Math.floor(Math.random() * 1e9)
            const messageId = `${adapter.selfId}.${now}.${messageSeq}`

            const contact = groupId
              ? contactGroup(groupId, 'MCP Group')
              : contactFriend(userId, nickname || 'MCP User')
            const sender = groupId
              ? senderGroup(userId, role as any, nickname || 'MCP User')
              : senderFriend(userId, nickname || 'MCP User')

            const elements = [segment.text(message)]

            const record = {
              direction: 'in',
              traceId,
              time: now,
              messageId,
              messageSeq,
              userId,
              groupId: groupId || null,
              nickname: nickname || null,
              role: groupId ? role : null,
              message,
            }

            inbox.unshift(record)
            if (inbox.length > maxHistory) inbox.length = maxHistory

            traces.set(traceId, { createdAt: now, request: record, responses: [] })
            const timer = setTimeout(() => traces.delete(traceId), traceTtlMs)
            timer.unref?.()

            traceStorage.run({ traceId }, () => {
              const base = {
                bot: adapter,
                contact,
                sender,
                elements,
                eventId: messageId,
                messageId,
                messageSeq,
                rawEvent: { source: 'mcp', traceId, data },
                time: now,
                srcReply: (els: any) => adapter!.sendMsg(contact as any, els),
              }
              if (groupId) createGroupMessage(base as any)
              else createFriendMessage(base as any)
            })

            if (waitMs > 0) await sleep(waitMs)

            const responses = traces.get(traceId)?.responses ?? []
          let traceFile: { date: string, file: string } | null = null
          let sessionFile: { date: string, file: string } | null = null

          const dateKey = new Date(now).toISOString().slice(0, 10)
          const traceRecord = {
            traceId,
            time: now,
            action,
            request: { ...data, injected: record },
            responses,
            durationMs: Date.now() - startedAt,
          }

          let traceFileName: string | null = null
          try {
            const filePath = writeTraceRecord(traceRecord)
            traceFileName = path.basename(filePath)
            traceFile = { date: dateKey, file: traceFileName }
          } catch {
            // ignore
          }

          try {
            const sessionLogPath = recordSession({ ...traceRecord, traceFile: traceFileName })
            if (sessionLogPath) sessionFile = { date: dateKey, file: path.basename(sessionLogPath) }
          } catch {
            // ignore
          }

            replyJson(200, {
              success: true,
              action,
              data: {
                traceId,
                injected: record,
                responses,
                traceFile,
                sessionFile,
              },
              time: Date.now(),
            })
            return
          } finally {
            releases.forEach((fn) => fn())
          }
        }

        case 'render.screenshot': {
          const file = toStr(data?.file).trim()
          const typeRaw = toStr(data?.type).trim()
          const fileTypeRaw = toStr(data?.file_type).trim()
          const filenameInput = toStr(data?.filename).trim()
          const returnMode = (toStr(data?.return).trim() || 'url').toLowerCase()
          const traceIdInput = toStr(data?.traceId).trim()
          const echoFile = Boolean(data?.echoFile)

          if (!file) throw new Error('file 不能为空')

          const normalizeOutputType = (t: string) => {
            const v = t.trim().toLowerCase()
            if (v === 'jpg') return 'jpeg'
            return v
          }

          const ext = ['png', 'jpeg', 'webp'].includes(normalizeOutputType(typeRaw)) ? normalizeOutputType(typeRaw) : 'png'

          const normalizeFileType = (t: string): string | undefined => {
            const v = t.trim()
            if (!v) return undefined
            const low = v.toLowerCase()
            if (low === 'auto') return undefined
            if (low === 'html' || low === 'htmlstring') return 'htmlString'
            if (low === 'vue' || low === 'vue3') return 'vue3'
            if (low === 'vuestring' || low === 'vue-string') return 'vueString'
            return v
          }

          const fileType = normalizeFileType(fileTypeRaw)
          const safeTraceId = traceIdInput ? traceIdInput.replaceAll(/[^\w-]/g, '') : ''
          const tracePrefix = safeTraceId ? `trace-${safeTraceId}-` : ''

          const sanitizeFilename = (name: string) => {
            const base = path.basename(name).replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, '_')
            return base || `mcp-render.${ext}`
          }

          const ensureExt = (name: string) => {
            const safe = sanitizeFilename(name)
            if (safe.toLowerCase().endsWith(`.${ext}`)) return safe
            const parsed = path.parse(safe)
            return `${parsed.name}.${ext}`
          }

          const baseFilename = filenameInput ? ensureExt(filenameInput) : `${tracePrefix}mcp-render-${Date.now()}.${ext}`

          mkdirSync(renderDir, { recursive: true })

          const isHtmlString = fileType === 'htmlString' || (!fileType && file.trimStart().startsWith('<'))
          const inputKind = isHtmlString
            ? 'htmlString'
            : /^(https?:)?\/\//i.test(file) ? 'url' : 'path'

          const truncateText = (s: string, maxLen: number) => (s.length > maxLen ? `${s.slice(0, maxLen)}…` : s)
          const inputBytes = Buffer.byteLength(file, 'utf8')
          const inputSha256 = isHtmlString
            ? crypto.createHash('sha256').update(file, 'utf8').digest('hex')
            : null

          const renderOptions: any = {
            name: 'mcp-render',
            file: isHtmlString
              ? (() => {
                const parsed = path.parse(baseFilename)
                const htmlFilename = `${parsed.name}-${Date.now()}.html`
                const htmlPath = path.join(renderDir, htmlFilename)
                writeFileSync(htmlPath, file, { encoding: 'utf8' })
                return htmlPath
              })()
              : file,
            type: ext,
            encoding: 'base64',
          }
          if (fileType && !isHtmlString) renderOptions.file_type = fileType
          if (typeof data?.multiPage === 'number' || typeof data?.multiPage === 'boolean') renderOptions.multiPage = data.multiPage
          if (typeof data?.fullPage === 'boolean') renderOptions.fullPage = data.fullPage
          if (typeof data?.quality === 'number') renderOptions.quality = data.quality
          if (data?.headers && typeof data.headers === 'object') renderOptions.headers = data.headers
          if (data?.setViewport && typeof data.setViewport === 'object') renderOptions.setViewport = data.setViewport
          if (data?.pageGotoParams && typeof data.pageGotoParams === 'object') renderOptions.pageGotoParams = data.pageGotoParams
          if (data?.waitForSelector) renderOptions.waitForSelector = data.waitForSelector
          if (data?.waitForFunction) renderOptions.waitForFunction = data.waitForFunction
          if (data?.waitForRequest) renderOptions.waitForRequest = data.waitForRequest
          if (data?.waitForResponse) renderOptions.waitForResponse = data.waitForResponse
          if (data?.data && typeof data.data === 'object') renderOptions.data = data.data

          const rendered = await render.render(renderOptions)
          const images = Array.isArray(rendered) ? rendered : [rendered]

          const normalizeBase64 = (value: string) => (value.startsWith('base64://') ? value.slice('base64://'.length) : value)

          const results = await Promise.all(
            images.map(async (img, index) => {
              const base64 = normalizeBase64(String(img))
              const buffer = Buffer.from(base64, 'base64')

              const filename = images.length === 1
                ? baseFilename
                : (() => {
                  const parsed = path.parse(baseFilename)
                  return `${parsed.name}-${index + 1}${parsed.ext || `.${ext}`}`
                })()

              const filePath = path.join(renderDir, filename)
              writeFileSync(filePath, buffer)

              let urlInfo: any = null
              if (returnMode !== 'filepath') {
                try {
                  urlInfo = await fileToUrl('image', buffer, filename)
                } catch (error: any) {
                  const message = toStr(error?.message || error).trim()
                  if (message.includes('没有配置文件转换为url的处理器')) {
                    if (!fileToUrlMissingHandlerLogged) {
                      fileToUrlMissingHandlerLogged = true
                      logger.debug(`[${pluginName}] fileToUrl handler not configured; using ${mcpPath}/files fallback`)
                    }
                  } else {
                    logger.warn(`[${pluginName}] fileToUrl failed: ${message}`)
                  }
                }
              }

              const fallbackUrl = (() => {
                return `${getLocalBaseUrl()}${mcpPath}/files/${encodeURIComponent(filename)}`
              })()

              const url = urlInfo?.url ?? fallbackUrl
              const width = urlInfo?.width ?? null
              const height = urlInfo?.height ?? null

              return {
                url: returnMode === 'filepath' ? null : url,
                filePath: returnMode === 'url' ? null : filePath,
                width,
                height,
                filename,
              }
            }),
          )

          replyJson(200, {
            success: true,
            action,
            data: {
              file: echoFile ? truncateText(file, 2000) : null,
              input: {
                kind: inputKind,
                fileType: fileType || 'auto',
                bytes: inputBytes,
                sha256: inputSha256,
              },
              type: ext,
              count: results.length,
              results,
            },
            time: Date.now(),
          })
          return
        }

        default: {
          if (extAction) {
            const validated = validateInputSchema(extAction.inputSchema, data)
            if (!validated.ok) {
              replyJson(400, { success: false, action, error: validated.error })
              return
            }

            const startedAt = Date.now()
            const result = await extAction.handler({ req, data })
            replyJson(200, {
              success: true,
              action,
              data: result,
              costMs: Date.now() - startedAt,
              time: Date.now(),
            })
            return
          }

          replyJson(404, { success: false, action, error: `Unknown action: ${action}` })
          return
        }
      }
    } catch (error: any) {
      replyJson(500, {
        success: false,
        action,
        error: error?.message || String(error),
        time: Date.now(),
      })
    }
  }

  const dispose = async () => {
    unregisterAdapter()
    await stopMcpServerProcess()
  }

  registerAdapter()
  startMcpServerProcess()

  logger.mark(`[${pluginName}] ready: ${mcpPath}`)

  return {
    handleHealth,
    handleApi,
    handleFile,
    dispose,
  }
}
