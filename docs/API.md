# API

## 鉴权 / 安全
本插件默认**不做 Key 鉴权**（预期仅本机/内网使用）。如需限制访问，请在 Web UI 配置：

- `security.ipAllowlist`：IP/CIDR 白名单（IPv4 CIDR 示例：`192.168.1.0/24`）

> 注意：启用白名单时请包含本机 `127.0.0.1` / `::1`，否则插件内的 `mcp-server` 将无法访问 HTTP Bridge。

## 健康检查
- `GET /MCP/health`
  - 不做鉴权（用于健康探测）

## 文件访问（渲染产物）
- `GET /MCP/files/:filename`
  - `render.screenshot` 会写入产物到 `data/mcp-render`

## Actions（`POST /MCP/api/:action`）

### `bot.status`
返回 Karin 与本插件运行状态。

### `meta.actions`
列出当前可用 actions（含内置与扩展 actions）。

### `mock.incoming.message`
注入入站消息（带 `group_id` 视为群聊），并按 `traceId` 聚合回包。

请求参数（JSON）：
- `message` string（必填）
- `user_id` string（必填）
- `group_id` string（可选）
- `nickname` string（可选）
- `role` string（群聊可选：member/admin/owner）
- `waitMs` number（可选，默认 1200）
- `traceId` string（可选，默认自动生成）

返回数据：
- `data.traceId`
- `data.responses`（聚合回包）
- `data.traceFile`（落盘 trace 文件信息：`{ date, file }`）
- `data.sessionFile`（会话 JSONL 文件信息：`{ date, file }`，用于低 token 回看）

### `mock.status`
返回 mock 环境统计（inbox/outbox/trace 数量）。

### `mock.history`
查看 mock 收发历史。

请求参数（JSON）：
- `type` string（in/out，可选）
- `limit` number（可选，默认 50，最大 200）

### `render.screenshot`
使用 Karin 渲染器截图并返回 `url` / `filePath`（或两者）。

请求参数（JSON）：
- `file` string（必填：URL/本地路径/HTML 字符串）
- `file_type` string（可选：auto/htmlString/vue3/vueString/react）
- `type` string（可选：png/jpeg/webp，默认 png）
- `filename` string（可选：输出文件名）
- `return` string（可选：url/filePath/both，默认 url）
- `echoFile` boolean（可选：是否回显输入 file，默认 false；回显会截断）
- `traceId` string（可选：给产物文件名前缀 `trace-<id>-`）
- 其它渲染参数：`fullPage`、`multiPage`、`setViewport`、`pageGotoParams`、`headers`、`data` 等

### `config.get`（可选）
只读读取插件配置（用于 IDE/LLM 排障/查看），是否可用取决于 Web UI 配置：
- `mcpTools.configRead=true`

### 测试记录（JSON）
用于保存/查询 LLM <-> Bot 的测试调用记录（HTTP JSONL + 会话 sessions JSONL + trace JSON）。

- `test.records.list`：列出记录文件（http/sessions/traces）
  - 参数：`date?`、`limit?`
- `test.records.tail`：读取某天 JSONL 尾部
  - 参数：`kind?`（http/sessions，默认 http）、`date?`、`limit?`、`traceId?`（仅 sessions 可选过滤）
- `test.trace.get`：读取 trace 记录（按 `date+file` 或 `traceId`）
  - 参数：`date?`、`file?`、`traceId?`

### 场景测试（JSON 回归基础）
- `test.scenarios.list`：列出内置测试场景
- `test.scenario.run`：运行一个场景并生成 run 记录
  - 参数：`scenarioId`（必填）、`sessionId?`、`defaults?`
- `test.scenarios.runAll`：运行全部场景并生成 suite 记录
  - 参数：`sessionId?`、`defaults?`

## Web 配置（Karin Web UI）
本插件提供 `web.config`，可在 Karin 插件配置界面直接编辑并保存：
- `mcpPath`：HTTP Bridge 挂载路径（修改后会热更新并重启 stdio `mcp-server`）
- `command.view` / `command.allowUserIds` / `command.allowGroupIds`：聊天命令访问控制（仅查看）
- `mcpTools.configRead`：是否开放 `config.get`（只读）
- `runtime.maxHistory` / `runtime.traceTtlMs`
- `artifacts.maxCount` / `artifacts.maxAgeMs`
- `limits.*`：按 user/group 的限流与并发控制
- `security.ipAllowlist`：IP/CIDR 白名单

## 聊天命令（查看为主）
配置修改一律在 Web UI 完成：
- `#mcp 帮助`（图片）
- `#mcp 配置`（图片）
- `#mcp 状态`（图片）
- `#mcp 导出配置`（文本 JSON：用于配置 MCP Host）
