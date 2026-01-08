import path from 'node:path'

import { karin, logger, render, segment } from 'node-karin'

import { dir } from '@/dir'
import { getLocalBaseUrl } from '@/mcp/baseUrl'
import { toStr } from '@/mcp/utils'
import { getEffectiveMcpPath, getMcpPluginConfig } from '@/utils/config'
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

const buildTextHelp = (options: {
  mcpUrl: string
  configPath: string
  mcpServerPath: string
}) => {
  return [
    `【${dir.name} v${dir.version}】`,
    '用途：让 LLM/IDE 通过 MCP(stdio) 调用 Karin（mcp-server -> HTTP Bridge -> Bot Adapter）。',
    '',
    '命令（只读）：',
    '- #mcp 帮助',
    '- #mcp 配置（修改配置请前往 Web UI）',
    '- #mcp 状态',
    '- #mcp 导出配置（返回 MCP Host 配置 JSON）',
    '',
    'HTTP Bridge：',
    `- 地址：${options.mcpUrl}`,
    `- 健康检查：GET ${options.mcpUrl}/health`,
    `- 渲染产物：GET ${options.mcpUrl}/files/:filename`,
    `- Actions：POST ${options.mcpUrl}/api/bot.status | mock.incoming.message | mock.status | mock.history | render.screenshot | meta.actions | config.get（需开启） | test.scenarios.list | test.scenario.run | test.scenarios.runAll | test.records.list | test.records.tail | test.trace.get`,
    '',
    '安全：',
    '- 默认无 Key 鉴权（仅建议本机/内网使用）。',
    '- 如需限制访问，请在 Web UI 配置 security.ipAllowlist（IP/CIDR 白名单）。',
    `- 配置文件：${options.configPath}`,
    '',
    'MCP Server（给 IDE/MCP Host 配置）：',
    `- 启动文件：${options.mcpServerPath}`,
    `- 推荐 args：--karin-url ${options.mcpUrl} --log-level error`,
    '',
    '更多说明：docs/API.md',
  ].join('\n')
}

export const mcpHelp = karin.command(/^#?mcp(?:\s*(?:帮助|help))?$/i, async (e) => {
  const baseUrl = getLocalBaseUrl()
  const mcpPath = getEffectiveMcpPath()
  const mcpUrl = `${baseUrl}${mcpPath}`

  const configPath = path.join(dir.ConfigDir, 'config.json')
  const mcpServerPath = path.join(dir.pluginDir, 'lib', 'mcp-server.js')

  try {
    if (!hasViewPermission(e)) {
      await e.reply('权限不足：请在 Web UI 配置 command.view / allowlist 后重试。')
      return true
    }

    await ensurePluginResources()
    const html = path.join(dir.defResourcesDir, 'template', 'mcp-help.html')

    const img = await render.render({
      name: 'mcp-help',
      encoding: 'base64',
      file: html,
      type: 'png',
      data: {
        name: dir.name,
        version: dir.version,
        generatedAt: formatDateTime(new Date()),
        mcpUrl,
        authText: 'No Key (IP allowlist optional)',
        configPath,
        mcpServerPath,
      },
      setViewport: {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 2,
      },
      pageGotoParams: {
        waitUntil: 'networkidle2',
      },
    }) as string

    await e.reply(segment.image(`base64://${img}`))
    return true
  } catch (error: any) {
    logger.error(error)
    await e.reply(buildTextHelp({ mcpUrl, configPath, mcpServerPath }))
    return true
  }
}, {
  priority: 9999,
  log: true,
  name: 'MCP帮助',
  permission: 'all',
})
