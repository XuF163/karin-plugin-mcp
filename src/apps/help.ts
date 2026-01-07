import path from 'node:path'

import { karin, logger, render, segment } from 'node-karin'

import { dir } from '@/dir'
import { getLocalBaseUrl } from '@/mcp/baseUrl'
import { toStr } from '@/mcp/utils'
import { getEffectiveApiKey, getEffectiveMcpPath } from '@/utils/config'
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

const maskSecret = (value: string): string => {
  const s = toStr(value).trim()
  if (!s) return ''
  if (s.length <= 4) return '*'.repeat(s.length)
  if (s.length <= 8) return `${s.slice(0, 1)}***${s.slice(-1)}`
  return `${s.slice(0, 2)}***${s.slice(-2)}`
}

const buildTextHelp = (options: {
  mcpUrl: string
  apiKey: string
  configPath: string
  mcpServerPath: string
}) => {
  const apiKeyMasked = options.apiKey ? maskSecret(options.apiKey) : ''
  return [
    `【${dir.name} v${dir.version}】`,
    '用途：让 LLM/IDE 通过 MCP(stdio) 调用 Karin（mcp-server → HTTP Bridge → Bot Adapter）',
    '',
    '指令：',
    '- #mcp 帮助：查看本帮助',
    '',
    'HTTP Bridge：',
    `- 地址：${options.mcpUrl}`,
    `- 健康检查：GET ${options.mcpUrl}/health`,
    `- 渲染产物：GET ${options.mcpUrl}/files/:filename`,
    `- Actions：POST ${options.mcpUrl}/api/bot.status | mock.incoming.message | mock.status | mock.history | render.screenshot`,
    '',
    '鉴权：',
    `- 当前：${options.apiKey ? `已启用（${apiKeyMasked}）` : '未启用（无需鉴权）'}`,
    `- 配置文件：${options.configPath}（mcpPath/apiKey）`,
    '- 设置优先级：环境变量 KARIN_MCP_API_KEY（优先）或 HTTP_AUTH_KEY > 配置文件 apiKey',
    '- 传递：X-API-Key / Authorization: Bearer <key> / ?apiKey=<key> / body.apiKey',
    '',
    'MCP Server（给 IDE/客户端配置）：',
    `- 启动文件：${options.mcpServerPath}`,
    `- 推荐 env：KARIN_MCP_URL=${options.mcpUrl}`,
    '- 或：KARIN_BASE_URL + KARIN_MCP_PATH；可选 KARIN_MCP_API_KEY',
    '',
    '更多说明：docs/API.md',
  ].join('\n')
}

export const mcpHelp = karin.command(/^#?mcp(?:\s*(?:帮助|help))?$/i, async (e) => {
  const baseUrl = getLocalBaseUrl()
  const mcpPath = getEffectiveMcpPath()
  const mcpUrl = `${baseUrl}${mcpPath}`

  const apiKey = getEffectiveApiKey()
  const apiKeyStatus = apiKey ? '已启用' : '未启用（无需鉴权）'
  const apiKeyMasked = apiKey ? maskSecret(apiKey) : '-'
  const configPath = path.join(dir.ConfigDir, 'config.json')
  const mcpServerPath = path.join(dir.pluginDir, 'lib', 'mcp-server.js')

  try {
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
        apiKeyStatus,
        apiKeyMasked,
        configPath,
        mcpServerPath,
      },
      setViewport: {
        width: 900,
        height: 860,
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
    await e.reply(buildTextHelp({ mcpUrl, apiKey, configPath, mcpServerPath }))
    return true
  }
}, {
  priority: 9999,
  log: true,
  name: 'MCP帮助',
  permission: 'all',
})
