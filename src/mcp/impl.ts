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
import { getEffectiveApiKey } from '../utils/config'
import { isAuthorized } from './auth'
import { getLocalBaseUrl } from './baseUrl'
import { McpAdapter, type TraceEntry } from './adapter/mcpAdapter'
import { clamp, sleep, toNum, toStr } from './utils'

const MAX_HISTORY = 200
const TRACE_TTL_MS = 5 * 60 * 1000

type TraceStore = { traceId: string }

export interface CreateMcpImplOptions {
  mcpPath: string
  pluginName: string
}

export interface McpImpl {
  apiKey: string
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

  const apiKey = getEffectiveApiKey()
  const renderDir = path.join(dir.karinPath, 'data', 'mcp-render')

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
          KARIN_MCP_API_KEY: apiKey,
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
    adapter = new McpAdapter({ traceStorage, traces, inbox, outbox })
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
    if (!isAuthorized(req, apiKey)) {
      res.status(401).json({ success: false, error: 'Unauthorized' })
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

  const handleApi = async (req: Request, res: Response) => {
    const action = toStr((req.params as any)?.action).trim()
    if (!isAuthorized(req, apiKey)) {
      res.status(401).json({ success: false, error: 'Unauthorized' })
      return
    }

    const data = req.method === 'GET' ? (req.query as any) : (req.body as any)

    try {
      switch (action) {
        case 'bot.status': {
          res.json({
            success: true,
            action,
            data: {
              plugin: pluginName,
              mcpPath,
              http: { baseUrl: getLocalBaseUrl() },
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
              bots: getAllBot().map((bot) => ({ selfId: bot.selfId, adapter: bot.adapter?.name })),
            },
            time: Date.now(),
          })
          return
        }

        case 'mock.status': {
          res.json({
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
          res.json({
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
          if (inbox.length > MAX_HISTORY) inbox.length = MAX_HISTORY

          traces.set(traceId, { createdAt: now, request: record, responses: [] })
          const timer = setTimeout(() => traces.delete(traceId), TRACE_TTL_MS)
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
          res.json({
            success: true,
            action,
            data: {
              traceId,
              injected: record,
              responses,
            },
            time: Date.now(),
          })
          return
        }

        case 'render.screenshot': {
          const file = toStr(data?.file).trim()
          const type = toStr(data?.type).trim() || 'png'
          const fileType = toStr(data?.file_type).trim() || undefined
          const filenameInput = toStr(data?.filename).trim()
          const returnMode = (toStr(data?.return).trim() || 'url').toLowerCase()

          if (!file) throw new Error('file 不能为空')

          const ext = ['png', 'jpeg', 'webp'].includes(type) ? type : 'png'

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

          const baseFilename = filenameInput ? ensureExt(filenameInput) : `mcp-render-${Date.now()}.${ext}`

          mkdirSync(renderDir, { recursive: true })

          const isHtmlString = fileType === 'htmlString' || (!fileType && file.trimStart().startsWith('<'))

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
              try {
                urlInfo = await fileToUrl('image', buffer, filename)
              } catch (error: any) {
                logger.warn(`[${pluginName}] fileToUrl failed: ${error?.message || error}`)
              }

              const fallbackUrl = (() => {
                const keyPart = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ''
                return `${getLocalBaseUrl()}${mcpPath}/files/${encodeURIComponent(filename)}${keyPart}`
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

          res.json({
            success: true,
            action,
            data: {
              file,
              type: ext,
              count: results.length,
              results,
            },
            time: Date.now(),
          })
          return
        }

        default: {
          res.status(404).json({ success: false, error: `Unknown action: ${action}` })
          return
        }
      }
    } catch (error: any) {
      res.status(500).json({
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

  logger.mark(`[${pluginName}] ready: ${mcpPath} (apiKey=${apiKey ? 'set' : 'unset'})`)

  return { apiKey, handleHealth, handleApi, handleFile, dispose }
}
