import { components, defineConfig } from 'node-karin'

import { dir } from './dir'
import { initMcpPlugin } from './mcp/init'
import { toStr } from './mcp/utils'
import {
  type McpCommandAccessLevel,
  getMcpPluginConfig,
  saveMcpPluginConfig,
} from './utils/config'

const icon = { name: 'plug', size: 24, color: '#2563eb' }

const accessOptions = [
  { value: 'master', label: '仅主人' },
  { value: 'admin', label: '主人 + Bot管理员' },
  { value: 'whitelist', label: '白名单（用户/群）' },
  { value: 'all', label: '所有人（不推荐）' },
] as const satisfies ReadonlyArray<{ value: McpCommandAccessLevel, label: string }>

export default defineConfig({
  icon,
  info: {
    id: dir.name,
    name: 'Karin MCP Bridge',
    version: dir.version,
    description: toStr(dir.pkg?.description).trim() || 'Karin MCP bridge plugin (stdio MCP server + /MCP HTTP bridge)',
    icon,
    author: toStr(dir.pkg?.author).trim() ? [{ name: toStr(dir.pkg?.author).trim(), home: '', avatar: '' }] : undefined,
  },
  components: () => {
    const cfg = getMcpPluginConfig()

    return [
      components.input.string('mcpPath', {
        label: 'MCP 挂载路径',
        description: 'HTTP Bridge 的挂载路径（例如 /MCP）。修改后会重启 MCP Server（stdio）进程。',
        defaultValue: cfg.mcpPath,
        isRequired: true,
        rules: [
          { regex: '^/.*', error: '必须以 / 开头' },
          { maxLength: 64, error: '路径长度不能超过 64' },
        ],
      }),
      components.divider.create('divider1'),
      components.radio.group('command_view', {
        label: '命令访问（查看）',
        orientation: 'horizontal',
        description: '谁可以使用 #mcp 帮助 / #mcp 配置 / #mcp 状态 等查看指令。',
        defaultValue: cfg.command.view,
        radio: accessOptions.map((o) => components.radio.create(o.value, { label: o.label, value: o.value })),
      }),
      components.input.group('command_allowUserIds', {
        label: '白名单用户（userId）',
        description: '当“命令访问”选择为白名单时生效；每一行一个 userId。',
        template: components.input.string('userId', { label: 'userId' }),
        data: cfg.command.allowUserIds,
      }),
      components.input.group('command_allowGroupIds', {
        label: '白名单群（groupId）',
        description: '当“命令访问”选择为白名单时生效；每一行一个 groupId。',
        template: components.input.string('groupId', { label: 'groupId' }),
        data: cfg.command.allowGroupIds,
      }),
      components.divider.create('divider2'),
      components.switch.create('mcpTools_configRead', {
        label: 'MCP Config Tools（读取）',
        description: '允许 IDE/LLM 通过 MCP 读取本插件配置。默认关闭。',
        defaultSelected: Boolean(cfg.mcpTools?.configRead),
      }),
      components.divider.create('divider4'),
      components.input.number('runtime_maxHistory', {
        label: '运行时：收发历史数量',
        description: 'inbox/outbox 的内存保留数量（每个方向各自限制）。范围：10-2000。',
        defaultValue: String(cfg.runtime?.maxHistory ?? 200),
        rules: [
          { min: 10, max: 2000, error: '范围：10-2000' },
        ],
      }),
      components.input.number('runtime_traceTtlSec', {
        label: '运行时：Trace TTL（秒）',
        description: 'traceId 聚合数据的过期时间。范围：10-3600 秒。',
        defaultValue: String(Math.round((cfg.runtime?.traceTtlMs ?? 300000) / 1000)),
        rules: [
          { min: 10, max: 3600, error: '范围：10-3600' },
        ],
      }),
      components.divider.create('divider5'),
      components.input.number('artifacts_maxCount', {
        label: '产物：最大数量',
        description: '渲染产物（data/mcp-render）最大保留数量；0 表示不限制（不推荐）。',
        defaultValue: String(cfg.artifacts?.maxCount ?? 200),
        rules: [
          { min: 0, max: 5000, error: '范围：0-5000' },
        ],
      }),
      components.input.number('artifacts_maxAgeDays', {
        label: '产物：最大保留天数',
        description: '超过该天数的渲染产物会被清理；0 表示不按时间清理。',
        defaultValue: String(Math.round((cfg.artifacts?.maxAgeMs ?? 604800000) / (24 * 60 * 60 * 1000))),
        rules: [
          { min: 0, max: 365, error: '范围：0-365' },
        ],
      }),
      components.divider.create('divider6'),
      components.switch.create('limits_enabled', {
        label: '限流：启用',
        description: '对 mock.incoming.message 进行按 user/group 的限流与并发控制，防止高频调用拖垮 bot。',
        defaultSelected: Boolean(cfg.limits?.enabled),
      }),
      components.input.number('limits_userMaxConcurrent', {
        label: '限流：每用户最大并发',
        description: '同一 user_id 的并发上限（至少 1）。',
        defaultValue: String(cfg.limits?.perUser?.maxConcurrent ?? 2),
        rules: [
          { min: 1, max: 50, error: '范围：1-50' },
        ],
      }),
      components.input.number('limits_userRps', {
        label: '限流：每用户 RPS',
        description: '令牌桶 refill 速率（每秒）。支持小数；0 表示只限制并发，不限制速率。',
        defaultValue: String(cfg.limits?.perUser?.rps ?? 2),
        rules: [
          { min: 0, max: 100, error: '范围：0-100' },
        ],
      }),
      components.input.number('limits_userBurst', {
        label: '限流：每用户 Burst',
        description: '令牌桶容量（至少 1）。',
        defaultValue: String(cfg.limits?.perUser?.burst ?? 4),
        rules: [
          { min: 1, max: 200, error: '范围：1-200' },
        ],
      }),
      components.input.number('limits_groupMaxConcurrent', {
        label: '限流：每群最大并发',
        description: '同一 group_id 的并发上限（至少 1）。',
        defaultValue: String(cfg.limits?.perGroup?.maxConcurrent ?? 4),
        rules: [
          { min: 1, max: 50, error: '范围：1-50' },
        ],
      }),
      components.input.number('limits_groupRps', {
        label: '限流：每群 RPS',
        description: '令牌桶 refill 速率（每秒）。支持小数；0 表示只限制并发，不限制速率。',
        defaultValue: String(cfg.limits?.perGroup?.rps ?? 4),
        rules: [
          { min: 0, max: 100, error: '范围：0-100' },
        ],
      }),
      components.input.number('limits_groupBurst', {
        label: '限流：每群 Burst',
        description: '令牌桶容量（至少 1）。',
        defaultValue: String(cfg.limits?.perGroup?.burst ?? 8),
        rules: [
          { min: 1, max: 200, error: '范围：1-200' },
        ],
      }),
      components.divider.create('divider7'),
      components.input.group('security_ipAllowlist', {
        label: '安全：IP/CIDR 白名单',
        description: '留空表示不限制；填入后仅允许白名单 IP 访问（注意包含本机 127.0.0.1 / ::1，否则 mcp-server 将无法访问）。',
        template: components.input.string('ipOrCidr', { label: 'IP / CIDR（例如 127.0.0.1 或 192.168.1.0/24）' }),
        data: cfg.security?.ipAllowlist || [],
      }),
    ]
  },
  save: async (config) => {
    try {
      const next = saveMcpPluginConfig({
        mcpPath: toStr(config?.mcpPath).trim(),
        command: {
          view: toStr(config?.command_view).trim() as any,
          allowUserIds: Array.isArray(config?.command_allowUserIds) ? config.command_allowUserIds : undefined,
          allowGroupIds: Array.isArray(config?.command_allowGroupIds) ? config.command_allowGroupIds : undefined,
        } as any,
        mcpTools: {
          configRead: Boolean(config?.mcpTools_configRead),
        } as any,
        runtime: {
          maxHistory: Number(config?.runtime_maxHistory),
          traceTtlMs: Number(config?.runtime_traceTtlSec) * 1000,
        } as any,
        artifacts: {
          maxCount: Number(config?.artifacts_maxCount),
          maxAgeMs: Number(config?.artifacts_maxAgeDays) * 24 * 60 * 60 * 1000,
        } as any,
        limits: {
          enabled: Boolean(config?.limits_enabled),
          perUser: {
            maxConcurrent: Number(config?.limits_userMaxConcurrent),
            rps: Number(config?.limits_userRps),
            burst: Number(config?.limits_userBurst),
          },
          perGroup: {
            maxConcurrent: Number(config?.limits_groupMaxConcurrent),
            rps: Number(config?.limits_groupRps),
            burst: Number(config?.limits_groupBurst),
          },
        } as any,
        security: {
          ipAllowlist: Array.isArray(config?.security_ipAllowlist) ? config.security_ipAllowlist : undefined,
        } as any,
      })

      await initMcpPlugin({ mcpPath: next.mcpPath })

      return {
        success: true,
        message: `保存成功：mcpPath=${next.mcpPath}（已尝试热更新）`,
      }
    } catch (error: any) {
      return { success: false, message: error?.message || String(error) }
    }
  },
})
