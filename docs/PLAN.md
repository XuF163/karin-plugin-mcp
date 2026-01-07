# 开发规划（karin-plugin-mcp）

## 已确认的决策
- 插件包名：`karin-plugin-mcp`
- 对外挂载路径：`/MCP`
- 通过“构造 Bot 适配器”的方式注入入站消息、捕获出站回复
- `mcp-server` 为独立进程（stdio），通过 HTTP 调用 `/MCP/api/*`

## 一期目标（最小闭环）
1. HTTP Bridge：`/MCP/health` 与 `/MCP/api/:action`（支持 `X-API-Key`）
2. Mock Adapter：注入私聊/群聊消息（`mock.incoming.message`），按 `traceId` 聚合回复
3. MCP Server（stdio）：实现 `initialize / tools/list / tools/call` 并转发到 HTTP Bridge
4. 渲染测试：`render.screenshot`，返回图片 `url` 或 `filePath`

## MCP tools
- `bot_status` → `bot.status`
- `mock_incoming_message` → `mock.incoming.message`
- `mock_status` → `mock.status`
- `mock_history` → `mock.history`
- `render_screenshot` → `render.screenshot`

