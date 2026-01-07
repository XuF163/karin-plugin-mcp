import path from 'node:path'

import { copyConfigSync, requireFileSync } from 'node-karin'

import { dir } from '@/dir'
import { toStr } from '@/mcp/utils'

export interface McpPluginConfig {
  mcpPath: string
  apiKey: string
}

const safeRequireJson = <T extends object = Record<string, unknown>>(filePath: string): T => {
  try {
    return requireFileSync(filePath) as T
  } catch {
    return {} as T
  }
}

export const ensurePluginConfig = () => {
  try {
    copyConfigSync(dir.defConfigDir, dir.ConfigDir, ['.json'])
  } catch {
    // ignore
  }
}

const normalizeMcpPath = (value: string): string => {
  const s = toStr(value).trim() || '/MCP'
  return s.startsWith('/') ? s : `/${s}`
}

export const getMcpPluginConfig = (): McpPluginConfig => {
  ensurePluginConfig()

  const def = safeRequireJson<Partial<McpPluginConfig>>(path.join(dir.defConfigDir, 'config.json'))
  const cfg = safeRequireJson<Partial<McpPluginConfig>>(path.join(dir.ConfigDir, 'config.json'))

  const merged: McpPluginConfig = {
    mcpPath: '/MCP',
    apiKey: '',
    ...def,
    ...cfg,
  }

  return {
    mcpPath: normalizeMcpPath(merged.mcpPath),
    apiKey: toStr(merged.apiKey).trim(),
  }
}

export const getEffectiveMcpPath = (): string => getMcpPluginConfig().mcpPath

export const getEffectiveApiKey = (): string => {
  const envKey = toStr(process.env.KARIN_MCP_API_KEY || process.env.HTTP_AUTH_KEY || '').trim()
  if (envKey) return envKey
  return getMcpPluginConfig().apiKey
}

