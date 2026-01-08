import path from 'node:path'

import { karin, logger, render, segment } from 'node-karin'

import { dir } from '@/dir'
import { getLocalBaseUrl } from '@/mcp/baseUrl'
import { toStr } from '@/mcp/utils'
import { getEffectiveMcpPath, getMcpPluginConfig, getMcpPluginConfigPath } from '@/utils/config'
import { ensurePluginResources } from '@/utils/resources'

const formatDateTime = (date: Date) => {
  try {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return date.toISOString()
  }
}

const renderTemplate = async (templateFilename: string, data: Record<string, any>) => {
  await ensurePluginResources()
  const html = path.join(dir.defResourcesDir, 'template', templateFilename)

  const img = await render.render({
    name: `mcp-${templateFilename.replace(/\W+/g, '-')}`,
    encoding: 'base64',
    file: html,
    type: 'png',
    data,
    setViewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2,
    },
    pageGotoParams: {
      waitUntil: 'networkidle2',
    },
  }) as string

  return img
}

const replyImage = async (e: any, base64: string) => {
  await e.reply(segment.image(`base64://${base64}`))
}

const getEventUserId = (e: any): string => {
  return toStr(e?.userId || e?.user_id || e?.sender?.userId || e?.sender?.user_id || e?.sender?.id || e?.user?.id).trim()
}

const getEventGroupId = (e: any): string => {
  return toStr(e?.groupId || e?.group_id || e?.group?.id || e?.group?.group_id || e?.contact?.id || e?.contact?.groupId || e?.contact?.group_id).trim()
}

const hasViewPermission = (e: any): boolean => {
  const cfg = getMcpPluginConfig()
  const level = cfg.command.view

  const isMaster = Boolean(e?.isMaster)
  const isAdmin = Boolean(e?.isAdmin)

  if (level === 'all') return true
  if (isMaster) return true
  if (level === 'master') return false
  if (level === 'admin') return isAdmin

  // whitelist
  if (isAdmin) return true
  const userId = getEventUserId(e)
  const groupId = getEventGroupId(e)
  if (userId && cfg.command.allowUserIds.includes(userId)) return true
  if (groupId && cfg.command.allowGroupIds.includes(groupId)) return true
  return false
}

const buildOverviewData = () => {
  const baseUrl = getLocalBaseUrl()
  const mcpPath = getEffectiveMcpPath()
  const mcpUrl = `${baseUrl}${mcpPath}`

  const cfg = getMcpPluginConfig()
  const allowlist = Array.isArray(cfg.security?.ipAllowlist) ? cfg.security.ipAllowlist : []
  const allowlistText = allowlist.length ? `启用（${allowlist.length} 条）` : '未启用（建议仅本机/内网使用）'

  return {
    name: dir.name,
    version: dir.version,
    generatedAt: formatDateTime(new Date()),
    mcpPath,
    mcpUrl,
    configPath: getMcpPluginConfigPath(),
    authText: 'No Key (IP allowlist optional)',
    ipAllowlistText: allowlistText,
  }
}

const postAction = async (action: string, data: Record<string, any> = {}) => {
  const baseUrl = getLocalBaseUrl()
  const mcpPath = getEffectiveMcpPath()
  const mcpUrl = `${baseUrl}${mcpPath}`

  const url = `${mcpUrl}/api/${action}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const errMsg = toStr(json?.error || json?.message || res.statusText || `HTTP ${res.status}`).trim()
    throw new Error(errMsg)
  }

  return json
}

export const mcpConfig = karin.command(/^#?mcp\s*(?:配置|config)\s*$/i, async (e) => {
  try {
    if (!hasViewPermission(e)) {
      await e.reply('权限不足：请在 Web UI 配置 command.view / allowlist 后重试。')
      return true
    }

    const img = await renderTemplate('mcp-config.html', buildOverviewData())
    await replyImage(e, img)
    return true
  } catch (error: any) {
    logger.error(error)
    await e.reply(`MCP 配置渲染失败：${error?.message || String(error)}`)
    return true
  }
}, {
  priority: 9998,
  log: true,
  name: 'MCP配置',
  permission: 'all',
})

export const mcpStatus = karin.command(/^#?mcp\s*(?:状态|status)\s*$/i, async (e) => {
  try {
    if (!hasViewPermission(e)) {
      await e.reply('权限不足：请在 Web UI 配置 command.view / allowlist 后重试。')
      return true
    }

    const overview = buildOverviewData()
    const result = await postAction('bot.status')
    const data = result?.data ?? {}

    const running = Boolean(data?.mcpServer?.running)
    const serverText = running ? 'MCP Server 运行中' : 'MCP Server 未运行'
    const serverClass = running ? 'ok' : 'warn'
    const mcpServerPid = data?.mcpServer?.pid ? `pid=${data.mcpServer.pid}` : ''

    const adapterSelfId = toStr(data?.adapter?.selfId || '-')
    const adapterIndex = toStr(data?.adapter?.index ?? '-')

    const traceCount = toStr(data?.buffers?.traces ?? 0)
    const inboxCount = toStr(data?.buffers?.inbox ?? 0)
    const outboxCount = toStr(data?.buffers?.outbox ?? 0)

    const runtimeText = `maxHistory=${toStr(data?.runtime?.maxHistory ?? '-')} traceTtlMs=${toStr(data?.runtime?.traceTtlMs ?? '-')}`

    const limits = data?.limits ?? {}
    const limitsText = `enabled=${toStr(limits?.enabled ?? '-')} user(c=${toStr(limits?.perUser?.maxConcurrent ?? '-')} rps=${toStr(limits?.perUser?.rps ?? '-')} b=${toStr(limits?.perUser?.burst ?? '-')}) group(c=${toStr(limits?.perGroup?.maxConcurrent ?? '-')} rps=${toStr(limits?.perGroup?.rps ?? '-')} b=${toStr(limits?.perGroup?.burst ?? '-')})`

    const rateKeysText = `userKeys=${toStr(data?.rateLimit?.userKeys ?? '-')} groupKeys=${toStr(data?.rateLimit?.groupKeys ?? '-')}`
    const artifactsText = `maxCount=${toStr(data?.artifacts?.maxCount ?? '-')} maxAgeMs=${toStr(data?.artifacts?.maxAgeMs ?? '-')}`

    const bots = Array.isArray(data?.bots) ? data.bots : []
    const botsText = bots.length
      ? bots.map((b: any, i: number) => `${i + 1}. ${toStr(b?.selfId || '-')}${b?.adapter ? `  (${toStr(b.adapter)})` : ''}`).join('\\n')
      : '-'

    const img = await renderTemplate('mcp-status.html', {
      ...overview,
      serverText,
      serverClass,
      mcpServerText: running ? 'Running' : 'Stopped',
      mcpServerPid,
      adapterSelfId,
      adapterIndex,
      traceCount,
      inboxCount,
      outboxCount,
      runtimeText,
      limitsText,
      rateKeysText,
      artifactsText,
      botsText,
    })

    await replyImage(e, img)
    return true
  } catch (error: any) {
    logger.error(error)
    await e.reply(`获取状态失败：${error?.message || String(error)}`)
    return true
  }
}, {
  priority: 9998,
  log: true,
  name: 'MCP状态',
  permission: 'all',
})

export const mcpExportConfig = karin.command(/^#?mcp\s*(?:导出配置|export(?:\s*config)?)\s*$/i, async (e) => {
  try {
    if (!hasViewPermission(e)) {
      await e.reply('权限不足：请在 Web UI 配置 command.view / allowlist 后重试。')
      return true
    }

    const baseUrl = getLocalBaseUrl()
    const mcpPath = getEffectiveMcpPath()
    const mcpUrl = `${baseUrl}${mcpPath}`

    const pluginCfg = getMcpPluginConfig()
    const configRead = Boolean(pluginCfg.mcpTools?.configRead)

    const mcpServerPath = path.join(dir.pluginDir, 'lib', 'mcp-server.js')

    const payload = {
      mcpServers: {
        'karin-mcp': {
          command: 'node',
          args: [
            mcpServerPath,
            '--karin-url',
            mcpUrl,
            '--log-level',
            'error',
            configRead ? '--config-read' : '--no-config-read',
          ],
        },
      },
    }

    const text = JSON.stringify(payload, null, 2)
    await e.reply(`\`\`\`json\n${text}\n\`\`\``)
    return true
  } catch (error: any) {
    logger.error(error)
    await e.reply(`导出配置失败：${error?.message || String(error)}`)
    return true
  }
}, {
  priority: 9998,
  log: true,
  name: 'MCP导出配置',
  permission: 'all',
})
