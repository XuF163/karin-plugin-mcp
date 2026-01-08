import express from 'node-karin/express'
import { app, logger } from 'node-karin'

import { dir } from '../dir'
import { createMcpImpl, type McpImpl } from './impl'

const GLOBAL_KEY = '__KARIN_PLUGIN_MCP__'

type GlobalContainer = {
  mountedPaths: Set<string>
  activePath: string
  impl: McpImpl | null
}

const ensureContainer = (): GlobalContainer => {
  const globalAny = globalThis as any
  if (!globalAny[GLOBAL_KEY]) {
    globalAny[GLOBAL_KEY] = { mountedPaths: new Set<string>(), activePath: '/MCP', impl: null } satisfies GlobalContainer
  }
  return globalAny[GLOBAL_KEY] as GlobalContainer
}

const mountRoutesOnce = (container: GlobalContainer, mountPath: string) => {
  if (container.mountedPaths.has(mountPath)) return

  const router = express.Router()

  router.use(express.json({ limit: '1mb' }))
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
    if (req.method === 'OPTIONS') return res.status(200).end()
    next()
  })

  router.use((req, res, next) => {
    // Hard-disable old routes after `mcpPath` changes to avoid:
    // - two active entrypoints (confusing for humans/clients)
    // - accidentally keeping an unprotected old path alive
    if (container.activePath !== mountPath) {
      return res.status(410).json({
        success: false,
        error: `MCP path changed: ${mountPath} -> ${container.activePath}`,
        activePath: container.activePath,
      })
    }
    next()
  })

  router.get('/health', (req, res) => container.impl?.handleHealth(req as any, res as any))
  router.get('/files/:filename', (req, res) => container.impl?.handleFile(req as any, res as any))
  router.all('/api/:action', (req, res) => container.impl?.handleApi(req as any, res as any))

  app.use(mountPath, router)

  container.mountedPaths.add(mountPath)
  logger.mark(`[${dir.name}] mounted: ${mountPath}`)
}

export const initMcpPlugin = async (options?: { mcpPath?: string }) => {
  const container = ensureContainer()

  const mcpPath = options?.mcpPath ?? '/MCP'
  if (container.activePath !== mcpPath) {
    logger.warn(`[${dir.name}] mcpPath changed: ${container.activePath} -> ${mcpPath} (old path will be disabled)`)
  }
  container.activePath = mcpPath

  if (container.impl?.dispose) {
    try {
      await container.impl.dispose()
    } catch (error: any) {
      logger.debug(`[${dir.name}] dispose previous impl failed: ${error?.message || error}`)
    }
  }

  container.impl = createMcpImpl({
    mcpPath,
    pluginName: dir.name,
    reloadPlugin: async (next) => initMcpPlugin({ mcpPath: next.mcpPath }),
  })
  mountRoutesOnce(container, mcpPath)
}
