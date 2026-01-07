# karin-plugin-mcp

让其它 LLM/IDE 通过 MCP（stdio）调用 Karin：`mcp-server`（stdio）→ HTTP Bridge（`/MCP`）→ Mock Adapter 注入消息/捕获回复。

## 开发
```bash
cd karin-plugin-mcp
pnpm i
pnpm dev
```

## 鉴权
如果设置了 `KARIN_MCP_API_KEY`（优先）或 `HTTP_AUTH_KEY`，则请求需携带：
- `X-API-Key: <key>`

## HTTP Bridge
挂载路径：`/MCP`

- `GET /MCP/health`
- `GET /MCP/files/:filename`（渲染产物）
- `POST /MCP/api/bot.status`
- `POST /MCP/api/mock.incoming.message`
- `POST /MCP/api/mock.status`
- `POST /MCP/api/mock.history`
- `POST /MCP/api/render.screenshot`

## MCP Server（stdio）
- 开发入口：`src/mcp-server.ts`
- 构建产物：`lib/mcp-server.js`

Tools：
- `bot_status`
- `mock_incoming_message`
- `mock_status`
- `mock_history`
- `render_screenshot`

更多说明见：`docs/API.md`
