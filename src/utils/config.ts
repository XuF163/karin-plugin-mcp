import fs from 'node:fs'
import path from 'node:path'

import { copyConfigSync, requireFileSync } from 'node-karin'

import { dir } from '@/dir'
import { toStr } from '@/mcp/utils'

export type McpCommandAccessLevel = 'master' | 'admin' | 'whitelist' | 'all'

export interface McpCommandConfig {
  /** Who can view help/config/status cards. */
  view: McpCommandAccessLevel
  /** Allowed user ids (applies to view when level is `whitelist`). */
  allowUserIds: string[]
  /** Allowed group ids (applies to view when level is `whitelist`). */
  allowGroupIds: string[]
}

export interface McpMcpToolsConfig {
  /** Allow MCP/HTTP to read plugin config (masked). */
  configRead: boolean
}

export interface McpRuntimeConfig {
  /** In-memory inbox/outbox history size (per direction). */
  maxHistory: number
  /** Trace TTL in milliseconds. */
  traceTtlMs: number
}

export interface McpArtifactsConfig {
  /** Max number of render artifacts to keep (0 means unlimited). */
  maxCount: number
  /** Delete artifacts older than this (0 means disabled). */
  maxAgeMs: number
}

export interface McpRateLimitRule {
  /** Max concurrent in-flight requests for a given key. */
  maxConcurrent: number
  /** Token refill rate per second. */
  rps: number
  /** Bucket capacity. */
  burst: number
}

export interface McpRateLimitConfig {
  enabled: boolean
  perUser: McpRateLimitRule
  perGroup: McpRateLimitRule
}

export interface McpSecurityConfig {
  /** Optional IP / CIDR allowlist. Empty means allow all IPs. */
  ipAllowlist: string[]
}

export interface McpPluginConfig {
  mcpPath: string
  command: McpCommandConfig
  mcpTools: McpMcpToolsConfig
  runtime: McpRuntimeConfig
  artifacts: McpArtifactsConfig
  limits: McpRateLimitConfig
  security: McpSecurityConfig
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

const normalizeAccessLevel = (value: unknown, fallback: McpCommandAccessLevel): McpCommandAccessLevel => {
  const v = toStr(value).trim().toLowerCase()
  if (v === 'master' || v === 'admin' || v === 'whitelist' || v === 'all') return v
  return fallback
}

const normalizeIdList = (value: unknown): string[] => {
  const arr = Array.isArray(value) ? value : []
  const uniq = new Set<string>()
  for (const item of arr) {
    const s = toStr(item).trim()
    if (!s) continue
    uniq.add(s)
  }
  return Array.from(uniq)
}

const normalizeCommandConfig = (value: Partial<McpCommandConfig> | undefined): McpCommandConfig => {
  const v = (value || {}) as Partial<McpCommandConfig>
  return {
    view: normalizeAccessLevel(v.view, 'master'),
    allowUserIds: normalizeIdList(v.allowUserIds),
    allowGroupIds: normalizeIdList(v.allowGroupIds),
  }
}

const normalizeMcpToolsConfig = (value: Partial<McpMcpToolsConfig> | undefined): McpMcpToolsConfig => {
  const v = (value || {}) as Partial<McpMcpToolsConfig>
  return {
    configRead: Boolean(v.configRead),
  }
}

const normalizeMaxHistory = (value: unknown, fallback: number) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 10) return 10
  if (n > 2000) return 2000
  return Math.floor(n)
}

const normalizeTraceTtlMs = (value: unknown, fallback: number) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 10_000) return 10_000
  if (n > 3_600_000) return 3_600_000
  return Math.floor(n)
}

const normalizeRuntimeConfig = (value: Partial<McpRuntimeConfig> | undefined): McpRuntimeConfig => {
  const v = (value || {}) as Partial<McpRuntimeConfig>
  return {
    maxHistory: normalizeMaxHistory(v.maxHistory, 200),
    traceTtlMs: normalizeTraceTtlMs(v.traceTtlMs, 5 * 60 * 1000),
  }
}

const normalizeArtifactsMaxCount = (value: unknown, fallback: number) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return fallback
  if (n > 5000) return 5000
  return Math.floor(n)
}

const normalizeArtifactsMaxAgeMs = (value: unknown, fallback: number) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return fallback
  if (n > 365 * 24 * 60 * 60 * 1000) return 365 * 24 * 60 * 60 * 1000
  return Math.floor(n)
}

const normalizeArtifactsConfig = (value: Partial<McpArtifactsConfig> | undefined): McpArtifactsConfig => {
  const v = (value || {}) as Partial<McpArtifactsConfig>
  return {
    maxCount: normalizeArtifactsMaxCount(v.maxCount, 200),
    maxAgeMs: normalizeArtifactsMaxAgeMs(v.maxAgeMs, 7 * 24 * 60 * 60 * 1000),
  }
}

const normalizeRateRule = (value: Partial<McpRateLimitRule> | undefined, fallback: McpRateLimitRule): McpRateLimitRule => {
  const v = (value || {}) as Partial<McpRateLimitRule>

  const maxConcurrent = (() => {
    const n = Number(v.maxConcurrent)
    if (!Number.isFinite(n)) return fallback.maxConcurrent
    if (n < 1) return 1
    if (n > 50) return 50
    return Math.floor(n)
  })()

  const rps = (() => {
    const n = Number(v.rps)
    if (!Number.isFinite(n)) return fallback.rps
    if (n < 0) return fallback.rps
    if (n > 100) return 100
    return n
  })()

  const burst = (() => {
    const n = Number(v.burst)
    if (!Number.isFinite(n)) return fallback.burst
    if (n < 1) return 1
    if (n > 200) return 200
    return Math.floor(n)
  })()

  return { maxConcurrent, rps, burst }
}

const normalizeRateLimitConfig = (value: Partial<McpRateLimitConfig> | undefined): McpRateLimitConfig => {
  const v = (value || {}) as Partial<McpRateLimitConfig>

  const userFallback: McpRateLimitRule = { maxConcurrent: 2, rps: 2, burst: 4 }
  const groupFallback: McpRateLimitRule = { maxConcurrent: 4, rps: 4, burst: 8 }

  return {
    enabled: Boolean(v.enabled),
    perUser: normalizeRateRule(v.perUser, userFallback),
    perGroup: normalizeRateRule(v.perGroup, groupFallback),
  }
}

const normalizeIpAllowlist = (value: unknown): string[] => {
  const arr = Array.isArray(value) ? value : []
  const uniq = new Set<string>()
  for (const item of arr) {
    const s = toStr(item).trim()
    if (!s) continue
    uniq.add(s)
  }
  return Array.from(uniq)
}

const normalizeSecurityConfig = (value: Partial<McpSecurityConfig> | undefined): McpSecurityConfig => {
  const v = (value || {}) as Partial<McpSecurityConfig>
  return {
    ipAllowlist: normalizeIpAllowlist(v.ipAllowlist),
  }
}

export const getMcpPluginConfigPath = (): string => path.join(dir.ConfigDir, 'config.json')

export const getDefaultMcpPluginConfig = (): McpPluginConfig => {
  const def = safeRequireJson<Partial<McpPluginConfig>>(path.join(dir.defConfigDir, 'config.json'))

  const merged: McpPluginConfig = {
    mcpPath: '/MCP',
    command: normalizeCommandConfig(def.command),
    mcpTools: normalizeMcpToolsConfig(def.mcpTools),
    runtime: normalizeRuntimeConfig(def.runtime),
    artifacts: normalizeArtifactsConfig(def.artifacts),
    limits: normalizeRateLimitConfig(def.limits),
    security: normalizeSecurityConfig(def.security),
    ...(def as any),
  }

  return {
    mcpPath: normalizeMcpPath(merged.mcpPath),
    command: normalizeCommandConfig(merged.command),
    mcpTools: normalizeMcpToolsConfig(merged.mcpTools),
    runtime: normalizeRuntimeConfig(merged.runtime),
    artifacts: normalizeArtifactsConfig(merged.artifacts),
    limits: normalizeRateLimitConfig(merged.limits),
    security: normalizeSecurityConfig(merged.security),
  }
}

export const getMcpPluginConfig = (): McpPluginConfig => {
  ensurePluginConfig()

  const def = safeRequireJson<Partial<McpPluginConfig>>(path.join(dir.defConfigDir, 'config.json'))
  const cfg = safeRequireJson<Partial<McpPluginConfig>>(path.join(dir.ConfigDir, 'config.json'))

  const merged: McpPluginConfig = {
    mcpPath: '/MCP',
    command: normalizeCommandConfig({ ...(def.command as any), ...(cfg.command as any) }),
    mcpTools: normalizeMcpToolsConfig({ ...(def.mcpTools as any), ...(cfg.mcpTools as any) }),
    runtime: normalizeRuntimeConfig({ ...(def.runtime as any), ...(cfg.runtime as any) }),
    artifacts: normalizeArtifactsConfig({ ...(def.artifacts as any), ...(cfg.artifacts as any) }),
    limits: normalizeRateLimitConfig({ ...(def.limits as any), ...(cfg.limits as any) }),
    security: normalizeSecurityConfig({ ...(def.security as any), ...(cfg.security as any) }),
    ...(def as any),
    ...(cfg as any),
  }

  return {
    mcpPath: normalizeMcpPath(merged.mcpPath),
    command: normalizeCommandConfig(merged.command),
    mcpTools: normalizeMcpToolsConfig(merged.mcpTools),
    runtime: normalizeRuntimeConfig(merged.runtime),
    artifacts: normalizeArtifactsConfig(merged.artifacts),
    limits: normalizeRateLimitConfig(merged.limits),
    security: normalizeSecurityConfig(merged.security),
  }
}

export const getEffectiveMcpPath = (): string => getMcpPluginConfig().mcpPath

export const saveMcpPluginConfig = (patch: Partial<McpPluginConfig>): McpPluginConfig => {
  ensurePluginConfig()
  const current = getMcpPluginConfig()

  const next: McpPluginConfig = {
    ...current,
    ...(patch as any),
    mcpPath: normalizeMcpPath(patch.mcpPath ?? current.mcpPath),
    command: normalizeCommandConfig({
      ...current.command,
      ...(patch.command || {}),
    }),
    mcpTools: normalizeMcpToolsConfig({
      ...current.mcpTools,
      ...(patch.mcpTools || {}),
    }),
    runtime: normalizeRuntimeConfig({
      ...current.runtime,
      ...(patch.runtime || {}),
    }),
    artifacts: normalizeArtifactsConfig({
      ...current.artifacts,
      ...(patch.artifacts || {}),
    }),
    limits: normalizeRateLimitConfig({
      ...current.limits,
      ...(patch.limits || {}),
    }),
    security: normalizeSecurityConfig({
      ...current.security,
      ...(patch.security || {}),
    }),
  }

  fs.mkdirSync(dir.ConfigDir, { recursive: true })
  fs.writeFileSync(getMcpPluginConfigPath(), `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' })

  return next
}

export const resetMcpPluginConfig = (): McpPluginConfig => {
  const def = getDefaultMcpPluginConfig()
  fs.mkdirSync(dir.ConfigDir, { recursive: true })
  fs.writeFileSync(getMcpPluginConfigPath(), `${JSON.stringify(def, null, 2)}\n`, { encoding: 'utf8' })
  return def
}

