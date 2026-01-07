# API

## 鉴权
如果设置了 `KARIN_MCP_API_KEY`（优先）或 `HTTP_AUTH_KEY`，则请求需携带：
- `X-API-Key: <key>`

## 健康检查
- `GET /MCP/health`

## 文件访问（渲染产物）
- `GET /MCP/files/:filename`
  - 默认会在 `render.screenshot` 时写入到插件数据目录 `data/mcp-render`
  - 如果设置了鉴权，建议使用 `?apiKey=<key>`（或自行携带 `X-API-Key`）

## Actions（`/MCP/api/:action`）
### `bot.status`
返回 Karin 与插件运行状态。

### `mock.incoming.message`
注入入站消息（带 `group_id` 视为群聊），并按 `traceId` 返回聚合回复。

请求参数（JSON）：
- `message` string（必填）
- `user_id` string（必填）
- `group_id` string（可选）
- `nickname` string（可选）
- `role` string（群聊可选：member/admin/owner）
- `waitMs` number（可选，默认 1200）
- `traceId` string（可选）

### `mock.status`
返回 inbox/outbox/trace 数量。

### `mock.history`
请求参数（JSON）：
- `type` string（可选：in/out）
- `limit` number（可选，默认 50，最大 200）

### `render.screenshot`
使用 Karin 渲染器截图并返回 `url` 或 `filePath`（或两者）。

请求参数（JSON）：
- `file` string（必填：URL/本地路径/HTML 字符串）
- `file_type` string（可选：auto/htmlString/vue3/vueString/react）
- `type` string（可选：png/jpeg/webp，默认 png）
- `filename` string（可选：输出文件名）
- `return` string（可选：url/filePath/both，默认 url）
- 其他渲染参数：`fullPage`、`multiPage`、`setViewport`、`pageGotoParams`、`headers`、`data` 等（按需传入）
