# karin-plugin-mcp

让 LLM/IDE 通过 MCP（stdio）调用 Karin：`mcp-server`（stdio） → HTTP Bridge（`/MCP`）→ Mock Adapter（注入消息/聚合回包/截图渲染）。

## 快速开始
```bash
cd karin-plugin-mcp
pnpm i
pnpm dev
```

默认 HTTP Bridge 挂载路径：`/MCP`

## 安全说明
本插件默认**不做 Key 鉴权**（预期仅本机/内网使用）。

如需限制访问，请在 Web UI 配置 `security.ipAllowlist`（IP/CIDR 白名单），并确保包含本机 `127.0.0.1` / `::1`。

## HTTP Bridge
- `GET /MCP/health`
- `GET /MCP/files/:filename`（渲染产物）
- `POST /MCP/api/bot.status`
- `POST /MCP/api/meta.actions`
- `POST /MCP/api/mock.incoming.message`
- `POST /MCP/api/mock.status`
- `POST /MCP/api/mock.history`
- `POST /MCP/api/render.screenshot`
- `POST /MCP/api/config.get`（可选：需 Web UI 开启 `mcpTools.configRead`）
- `POST /MCP/api/test.*`（JSON 测试记录与场景测试，详见 `docs/API.md`）

## JSON 测试记录
插件会把测试调用记录落盘到：
- `@karinjs/<plugin>/data/mcp-test/http/<date>.jsonl`（HTTP 请求/响应摘要）
- `@karinjs/<plugin>/data/mcp-test/traces/<date>/trace-<traceId>-<time>.json`（单次 trace 记录）
- `@karinjs/<plugin>/data/mcp-test/runs/<date>/run-<sessionId>-<time>.json`（场景运行记录）

## MCP Server（stdio）
- 开发入口：`src/mcp-server.ts`
- 构建产物：`lib/mcp-server.js`

推荐（低 token）工具：
- `quick_status`：状态摘要
- `send_message`：只传 `message` 即可注入测试消息（其它参数有默认值）
- `scenario.list` / `scenario.run` / `scenario.run_all`：场景库与一键回归
- `records.list` / `records.tail` / `trace.get`：查询测试记录

兼容工具：
- `action.call` / `action.list`
- `bot_status`
- `mock_incoming_message`
- `mock_status`
- `mock_history`
- `render_screenshot`
- `config.get`（可选）

### Stdio readiness (wait + retry)
This stdio MCP server proxies tool calls to Karin's HTTP bridge (base URL: `KARIN_MCP_URL`, default `http://127.0.0.1:7777/MCP`).
Tool calls will wait for `GET $KARIN_MCP_URL/health` and retry requests by default.

- Recommended (no env pollution): pass CLI flags via your MCP host config, e.g. Codex `config.toml`:
  - `args = ["D:/Karin/karin-plugin-mcp/lib/mcp-server.js", "--karin-url", "http://127.0.0.1:7777/MCP", "--ready-timeout-ms", "30000"]`

- `--karin-url` (override `KARIN_MCP_URL`)
- `--wait-ready` / `--no-wait-ready`
- `--config-read` / `--no-config-read`
- `--log-level` (debug/info/warn/error/silent) or `--quiet`
- `--ready-timeout-ms`
- `--ready-poll-ms`
- `--request-timeout-ms`
- `--request-retries`
- `--retry-backoff-ms`

- `KARIN_MCP_CONFIG_READ` (default: `0`)
- `KARIN_MCP_WAIT_READY` (default: `1`)
- `KARIN_MCP_READY_TIMEOUT_MS` (default: `30000`)
- `KARIN_MCP_READY_POLL_MS` (default: `500`)
- `KARIN_MCP_REQUEST_TIMEOUT_MS` (default: `15000`)
- `KARIN_MCP_REQUEST_RETRIES` (default: `1`)
- `KARIN_MCP_RETRY_BACKOFF_MS` (default: `400`)

## 配置（Web UI）
- Karin Web UI 支持 `web.config`（保存后热更新并重启 stdio `mcp-server`）
- 聊天命令（只读；全部图片回显，>=1920×1080）：
  - `#mcp 帮助`
  - `#mcp 配置`
  - `#mcp 状态`
  - `#mcp 导出配置`（文本 JSON）

更多说明见：`docs/API.md`
