import type { Router } from 'express'

import express from 'node-karin/express'
import { app, logger } from 'node-karin'

import { dir } from '../dir'
import { createMcpImpl, type McpImpl } from './impl'

const GLOBAL_KEY = '__KARIN_PLUGIN_MCP__'

type GlobalContainer = {
  mounted: boolean
  router: Router | null
  impl: McpImpl | null
}

const ensureContainer = (): GlobalContainer => {
  const globalAny = globalThis as any
  if (!globalAny[GLOBAL_KEY]) {
    globalAny[GLOBAL_KEY] = { mounted: false, router: null, impl: null } satisfies GlobalContainer
  }
  return globalAny[GLOBAL_KEY] as GlobalContainer
}

const mountRoutesOnce = (container: GlobalContainer, mcpPath: string) => {
  if (container.mounted) return

  const router = express.Router()

  router.use(express.json({ limit: '1mb' }))
  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
    if (req.method === 'OPTIONS') return res.status(200).end()
    next()
  })

  router.get('/health', (req, res) => container.impl?.handleHealth(req as any, res as any))
  router.get('/files/:filename', (req, res) => container.impl?.handleFile(req as any, res as any))
  router.all('/api/:action', (req, res) => container.impl?.handleApi(req as any, res as any))

  app.use(mcpPath, router)

  container.router = router
  container.mounted = true
  logger.mark(`[${dir.name}] mounted: ${mcpPath}`)
}

export const initMcpPlugin = async (options?: { mcpPath?: string }) => {
  const container = ensureContainer()
  if (container.impl?.dispose) {
    try {
      await container.impl.dispose()
    } catch (error: any) {
      logger.debug(`[${dir.name}] dispose previous impl failed: ${error?.message || error}`)
    }
  }

  const mcpPath = options?.mcpPath ?? '/MCP'
  container.impl = createMcpImpl({ mcpPath, pluginName: dir.name })
  mountRoutesOnce(container, mcpPath)
}
