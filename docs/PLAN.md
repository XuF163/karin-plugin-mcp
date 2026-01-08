# 开发规划（karin-plugin-mcp）

## 已确认的决策
- 插件包名：`karin-plugin-mcp`
- 对外挂载路径：`/MCP`
- 通过“构造 Bot 适配器”的方式注入入站消息、捕获出站回复
- `mcp-server` 为独立进程（stdio），通过 HTTP 调用 `/MCP/api/*`

## 一期（最小闭环）[DONE]
交付物：LLM/IDE 通过 MCP(stdio) → HTTP Bridge → Bot Adapter 完成“注入消息/捕获回复/截图渲染”的最小闭环。

1. HTTP Bridge：`/MCP/health` 与 `/MCP/api/:action`（无 Key；可选 IP allowlist）
2. Mock Adapter：注入私聊/群聊消息（`mock.incoming.message`），按 `traceId` 聚合回复
3. MCP Server（stdio）：实现 `initialize / tools/list / tools/call` 并转发到 HTTP Bridge
4. 渲染测试：`render.screenshot`，返回图片 `url` 或 `filePath`

## MCP tools
- `bot_status` → `bot.status`
- `mock_incoming_message` → `mock.incoming.message`
- `mock_status` → `mock.status`
- `mock_history` → `mock.history`
- `render_screenshot` → `render.screenshot`

---

## 二期（可配置性 & 高质量交互）[DONE]
下一步开发目标：
1. 适配 Karin Web 配置能力（web-config）
2. 命令交互仅保留只读卡片（与真人交互逻辑：**全部使用图片**，分辨率**至少 1920×1080**，优质/高级排版/逻辑清晰）

### 2.1 适配 Karin Web 配置能力（web-config）
目标：在 Karin Web UI 的插件管理/配置界面中，能够看到并编辑本插件配置，并可靠落盘到 `@karinjs/<plugin>/config/config.json`。

实施要点：
- 增加 `web.config`（开发态/生产态均可用）
  - 通过 `package.json#karin.web`（生产）与 `package.json#karin.ts-web`（开发）接入 Karin 的 web-config 发现机制。
- 默认组件配置：提供 `mcpPath` 的编辑能力。
- 保存：校验配置（如 `mcpPath` 规范化），写入配置文件并返回保存结果。
- Web 配置交互补强
- “当前生效值”解释（主要关注 `mcpPath` 与 `security.ipAllowlist`；Key 已移除）。
  - 配置保存后可选提供“健康检查/状态检查”入口（调用 `GET /MCP/health` 或 `bot.status`）。

验收标准：
- Karin Web UI 能识别到本插件存在可配置项（hasConfig=true 或等价表现）。
- 修改 `mcpPath` 后可落盘且重启后仍生效；`mcpPath` 展示与实际挂载一致。
- 若环境变量覆盖配置文件，Web UI 显示明确提示（并避免误导）。

### 2.2 命令只读卡（图片）
目标：在聊天中提供只读的帮助/配置摘要/运行状态卡片；所有配置修改一律引导到 Web UI。

命令：
- `#mcp 帮助`：帮助卡（图片）
- `#mcp 配置`：查看配置摘要（图片；修改配置请前往 Web UI）
- `#mcp 状态`：查看运行状态（图片）
- `#mcp 导出配置`：导出 MCP Host 配置片段（文本 JSON）

交互规范（强约束）：
- **图片为唯一展示载体**：帮助/配置/状态均使用渲染图片输出。
- **分辨率至少 1920×1080**：渲染 viewport 不低于 1920×1080；建议配合 `deviceScaleFactor=2` 提升清晰度。
- **高级排版**：统一版式与组件（标题区/信息区/提示区/页脚），对齐网格、留白合理、层级清晰。
- **安全**：默认无 Key 鉴权（仅建议本机/内网使用）；如需限制访问请配置 `security.ipAllowlist`；任何“修改配置”诉求均提示前往 Web UI。

验收标准：
- 三条命令均返回清晰的 1920×1080+ 图片；且在渲染失败时有文本 fallback。
- 所有页面均明确提示“配置修改请前往 Karin Web UI”。

### 2.3 文档与对外说明同步
- 更新 `README.md / docs/API.md / docs/PLAN.md`：保留查看类命令（含 `#mcp 导出配置`），并强调“配置修改仅 Web UI”。
- 更新 `src/apps/help.ts` 的帮助图：同步命令清单与 1920×1080 版式规范。

---

## 三期（开发者测试体系 & 内网无鉴权 & 低 Token DX）[TODO]
下一步开发目标：
1. 用 JSON 持久化记录 LLM <-> Bot 的测试命令/回复（覆盖所有测试场景，并支持回放）
2. 取消 Key 验证机制（默认仅本机/内网使用），仅保留 IP/CIDR 白名单作为安全边界（可选）
3. 减轻 LLM 调用 MCP 工具的复杂性，减少 token 消耗（更少的参数、更小的返回、更强的 presets）

### 3.1 使用 JSON 存储“测试命令记录”
目标：把“LLM 调用 MCP → HTTP Bridge → Bot Adapter → 聚合回复”的全链路请求与结果落盘为 JSON，便于：
- 回归测试（可重放、可对比）
- 复现问题（可以精确还原输入、环境与输出）
- 降低排障成本（从“凭记忆复现”变为“直接回放”）

设计要点：
- 存储位置（运行时）：Karin 运行目录下的插件数据目录（`data/`），按日期/traceId 分文件存储。
  - 推荐格式：JSON Lines（`.jsonl`，便于追加写入与大文件处理）；同时提供导出为 `.json` 的能力。
- 记录粒度：
  - MCP tool 调用（stdio 侧）：toolName、args、返回摘要（可选）
  - HTTP action 调用（/api/:action）：action、请求体、响应体（支持“compact”摘要）
  - Bot 交互（inbox/outbox）：注入消息、捕获回复、traceId 聚合结果、耗时与错误
- 数据脱敏：默认不保存敏感信息（即便后续仍存在），并支持对 message/回复做可配置截断（避免 token/磁盘爆炸）。
- 可回放：提供一个“回放器”按记录顺序重新执行（尽量纯 HTTP action 重放），并生成对比报告（成功/失败/耗时/差异）。

测试场景覆盖（必须覆盖的最小集合）：
- 基础闭环：私聊注入 / 群聊注入 / 多轮对话 / 不同 role（member/admin/owner）
- 行为边界：超长消息、特殊字符、空消息、非法参数、缺字段、异常 JSON
- 时序与并发：waitMs 超时、并发注入、同 traceId 复用、不同 traceId 并行
- 稳定性：限流触发与提示、缓冲区上限（maxHistory）、trace TTL 过期行为
- 路径与连通性：mcpPath 变更导致 410、health 可用性、files 访问可用性
- 渲染链路：render.screenshot（file/url/htmlString）、产物文件可下载、渲染失败路径
- 兼容性：MCP initialize/tools/list/tools/call/resources/list/prompts/list 基本可用

验收标准：
- 任意一次“测试执行”能产出可回放的 JSON 记录；回放结果可生成摘要报告。
- 能用一条命令（脚本）完成“执行全量测试场景 → 生成报告/产出记录”。

### 3.2 取消 Key 验证机制（内网/本机模式）
目标：彻底移除 `X-API-Key / Authorization / apiKey` 的鉴权要求，降低接入复杂度与 token 消耗（不再需要在 MCP Host 侧维护 key）。

安全边界（替代方案）：
- 仅保留 `security.ipAllowlist`（IP/CIDR）作为可选安全边界；默认建议限制为本机（`127.0.0.1/::1`）。
- 明确定位：该插件默认仅用于本机/内网开发调试，不建议暴露公网。

迁移策略：
- 已移除 `apiKey` / `security.tokens`（不再生效，也不再在 UI 与文档中出现），仅保留可选的 `security.ipAllowlist` 作为安全边界。
- MCP Host 示例配置统一简化为只需 `KARIN_MCP_URL`（不再需要 key）。

验收标准：
- MCP server 与 HTTP bridge 在无 key 情况下可正常工作（status/mock/render/files 均可用）。
- 开启 IP 白名单后，非白名单 IP 请求会被拒绝且错误提示明确。

### 3.3 降低 LLM 开发复杂度（减少 token 消耗）
目标：让 LLM 端“少想、少填、少看”，减少工具调用 JSON 体积与返回体积。

实施方向：
- 统一入口：提供“更短、更语义化”的工具别名/宏工具（例如 `send_message`/`run_scenario`），内部映射到现有 actions。
- 默认参数：为 `mock_incoming_message` 提供合理默认值（user_id/waitMs/traceId 自动生成），让 LLM 只需传 `message`（可选 group_id）。
- Compact 输出：为关键 actions/tools 增加 `compact=true`，默认返回纯文本摘要/关键字段，减少大对象返回。
- Presets：内置“常用测试场景”预设（与 3.1 的场景库一致），LLM 只需传 scenarioId 即可执行。
- Prompts/Resources：提供极短的“开发提示模板”，避免 LLM 在对话里反复复述长指令。

验收标准：
- 常见开发路径（注入消息、拿回复、截图渲染、查状态）在 1-2 次工具调用内完成，且入参最小化。
- 相同任务的工具调用 payload 相比当前减少明显（以记录文件中 JSON 体积/返回体积衡量）。

### 3.4 文档与示例同步
- 更新 `docs/API.md`：移除鉴权/key 相关说明，改为“内网模式 + IP 白名单”说明，并同步工具别名/compact/presets。
- 更新 `README.md`：提供最短上手路径（只需 URL），并给出“本机/内网使用建议”。
- 更新 MCP resources/prompts：提供 `quickstart`、`scenario list`、`replay how-to`。

---

## 版本路线图（未来五个版本）
说明：以当前 `v1.5.0` 为基线规划；命令交互维持“只读 + 图片化”，配置修改统一走 Web UI。

### v1.5.1（极简命令模式）[DONE]
目标：收敛真人交互面，只保留查看类命令，降低维护成本与攻击面。

范围：
- 聊天命令仅保留：`#mcp 帮助 / #mcp 配置 / #mcp 状态`（全部图片回显 ≥1920×1080）+ `#mcp 导出配置`（文本 JSON）。
- 移除聊天内配置修改/确认/回滚/重置、trace 面板、产物面板与危险清理等交互。
- 文档同步：README/API/PLAN 与模板一致。

### v1.6.0（内网无鉴权 & 接入最简化）
目标：取消 key 验证机制，让 MCP Host/LLM 侧只需配置 URL；默认定位为本机/内网使用。

范围：
- HTTP Bridge：移除 `X-API-Key/Authorization/apiKey` 鉴权要求（仅保留可选 IP 白名单）。
- Web UI：移除/弃用与 key 相关的配置项展示（或标记为不生效），并提供一键复制 MCP Host 配置片段（只含 URL）。
- MCP resources/prompts：更新 quickstart 与 troubleshooting，去掉 key 步骤。

### v1.7.0（测试命令记录：JSON 录制/回放）
目标：用 JSON 记录并可回放的方式覆盖所有测试场景，形成可持续迭代的回归体系。

范围：
- 录制：把 MCP/HTTP/Bot 交互链路落盘为 JSONL（支持 compact、脱敏、截断）。
- 场景库：内置并维护“覆盖所有测试场景”的最小集合（见 3.1）。
- 回放：提供脚本一键回放并生成报告（成功/失败/耗时/差异）。

### v1.8.0（低 Token DX：工具别名/默认参数/Compact 输出）
目标：显著降低 LLM 调用 MCP 工具的复杂度与 token 消耗。

范围：
- 工具别名/宏工具：面向开发者的短工具名与 presets（scenarioId 一键执行）。
- 默认参数：让最常用路径只传 message 即可完成注入与聚合。
- Compact 输出：关键接口默认返回摘要，必要时可切换 full 输出。

### v1.9.0（自动化回归 & 文档/示例自动生成）
目标：把测试记录体系与 meta/actions/resources/prompts 结合，形成“代码即文档、记录即测试”。

范围：
- 自动化：基于场景库与回放器，提供可持续运行的回归流水线（本地/CI）。
- 文档生成：从 meta.actions + 场景库自动生成接口清单、示例与最短上手说明。

