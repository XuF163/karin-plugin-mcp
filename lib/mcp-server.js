// src/mcp-server.ts
import crypto from "crypto";
import { pathToFileURL } from "url";
var ENV = process.env;
var parseBool = (value) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};
var parseCliConfig = () => {
  const cfg = {};
  const argv = process.argv.slice(2);
  const getValue = (raw, i) => {
    const eq = raw.indexOf("=");
    if (eq !== -1) return { value: raw.slice(eq + 1), next: i + 1 };
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) return { value: next, next: i + 2 };
    return { value: "", next: i + 1 };
  };
  const setNum = (key, value) => {
    const n = Number(value);
    if (Number.isFinite(n)) cfg[key] = n;
  };
  for (let i = 0; i < argv.length; ) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      i += 1;
      continue;
    }
    const flag = raw.split("=")[0];
    switch (flag) {
      case "--karin-url": {
        const { value, next } = getValue(raw, i);
        if (value) cfg.karinUrl = value;
        i = next;
        continue;
      }
      case "--wait-ready":
        cfg.waitReady = true;
        i += 1;
        continue;
      case "--no-wait-ready":
        cfg.waitReady = false;
        i += 1;
        continue;
      case "--config-read":
        cfg.configRead = true;
        i += 1;
        continue;
      case "--no-config-read":
        cfg.configRead = false;
        i += 1;
        continue;
      case "--log-level": {
        const { value, next } = getValue(raw, i);
        if (value) cfg.logLevel = value;
        i = next;
        continue;
      }
      case "--quiet":
        cfg.logLevel = "silent";
        i += 1;
        continue;
      case "--ready-timeout-ms": {
        const { value, next } = getValue(raw, i);
        setNum("readyTimeoutMs", value);
        i = next;
        continue;
      }
      case "--ready-poll-ms": {
        const { value, next } = getValue(raw, i);
        setNum("readyPollMs", value);
        i = next;
        continue;
      }
      case "--request-timeout-ms": {
        const { value, next } = getValue(raw, i);
        setNum("requestTimeoutMs", value);
        i = next;
        continue;
      }
      case "--request-retries": {
        const { value, next } = getValue(raw, i);
        setNum("requestRetries", value);
        i = next;
        continue;
      }
      case "--retry-backoff-ms": {
        const { value, next } = getValue(raw, i);
        setNum("retryBackoffMs", value);
        i = next;
        continue;
      }
      default:
        i += 1;
        continue;
    }
  }
  return cfg;
};
var CLI = parseCliConfig();
var baseUrl = CLI.karinUrl ? CLI.karinUrl : ENV.KARIN_MCP_URL ? ENV.KARIN_MCP_URL : `${ENV.KARIN_BASE_URL || "http://127.0.0.1:7777"}${ENV.KARIN_MCP_PATH || "/MCP"}`;
var MCP_CONFIG = {
  name: "karin-mcp",
  version: "1.5.0",
  description: "Karin Bot MCP Server",
  karinUrl: baseUrl
};
var MCP_FLAGS = {
  configRead: CLI.configRead ?? parseBool(ENV.KARIN_MCP_CONFIG_READ)
};
var LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};
var LOG_LEVEL = (() => {
  const v = String(CLI.logLevel ?? ENV.KARIN_MCP_LOG_LEVEL ?? "").trim().toLowerCase();
  if (!v) return "error";
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, v) ? v : "error";
})();
var canLog = (level) => {
  const current = LOG_LEVELS[LOG_LEVEL] ?? 1;
  const required = LOG_LEVELS[level] ?? 1;
  return current >= required;
};
var log = (level, message, data = null) => {
  if (!canLog(level)) return;
  const entry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    message,
    data
  };
  process.stderr.write(`${JSON.stringify(entry)}
`);
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var toNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));
var MCP_HTTP = {
  waitReady: CLI.waitReady ?? (ENV.KARIN_MCP_WAIT_READY === void 0 ? true : parseBool(ENV.KARIN_MCP_WAIT_READY)),
  readyTimeoutMs: clamp(toNum(CLI.readyTimeoutMs ?? ENV.KARIN_MCP_READY_TIMEOUT_MS, 3e4), 0, 5 * 6e4),
  readyPollMs: clamp(toNum(CLI.readyPollMs ?? ENV.KARIN_MCP_READY_POLL_MS, 500), 100, 5e3),
  requestTimeoutMs: clamp(toNum(CLI.requestTimeoutMs ?? ENV.KARIN_MCP_REQUEST_TIMEOUT_MS, 15e3), 250, 5 * 6e4),
  requestRetries: clamp(toNum(CLI.requestRetries ?? ENV.KARIN_MCP_REQUEST_RETRIES, 1), 0, 10),
  retryBackoffMs: clamp(toNum(CLI.retryBackoffMs ?? ENV.KARIN_MCP_RETRY_BACKOFF_MS, 400), 0, 1e4)
};
var parseJsonBestEffort = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2e3) };
  }
};
var fetchTextWithTimeout = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
};
var lastHealthOkAt = 0;
var waitForBridgeReady = async () => {
  if (!MCP_HTTP.waitReady) return;
  if (Date.now() - lastHealthOkAt < 1500) return;
  const healthUrl = `${MCP_CONFIG.karinUrl}/health`;
  const deadline = Date.now() + MCP_HTTP.readyTimeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const { res, text } = await fetchTextWithTimeout(
        healthUrl,
        { method: "GET" },
        clamp(Math.min(MCP_HTTP.requestTimeoutMs, 5e3), 250, 3e4)
      );
      if (res.ok) {
        lastHealthOkAt = Date.now();
        return;
      }
      const body = parseJsonBestEffort(text);
      if (res.status === 410 && body && typeof body === "object") {
        const error = String(body.error || "").trim();
        const activePath = String(body.activePath || "").trim();
        throw new Error(error || (activePath ? `MCP path changed, activePath=${activePath}` : "MCP path changed"));
      }
      lastError = new Error(`Health check failed: HTTP ${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (MCP_HTTP.readyTimeoutMs === 0) break;
    await sleep(MCP_HTTP.readyPollMs);
  }
  const detail = lastError && typeof lastError === "object" && "message" in lastError ? String(lastError.message || "").trim() : String(lastError || "").trim();
  throw new Error(
    [
      `Karin MCP HTTP bridge not ready: ${healthUrl}`,
      `waited=${MCP_HTTP.readyTimeoutMs}ms`,
      detail ? `lastError=${detail}` : null
    ].filter(Boolean).join(" ")
  );
};
var makeRequest = async (action, data = {}) => {
  const url = `${MCP_CONFIG.karinUrl}/api/${action}`;
  const headers = { "Content-Type": "application/json" };
  try {
    await waitForBridgeReady();
  } catch (error) {
    return {
      success: false,
      action,
      httpStatus: null,
      httpStatusText: "",
      error: error?.message || String(error),
      body: {
        karinUrl: MCP_CONFIG.karinUrl,
        healthUrl: `${MCP_CONFIG.karinUrl}/health`,
        hint: "Start Karin first, or pass `--karin-url http://127.0.0.1:7777/MCP` (or set KARIN_MCP_URL)."
      }
    };
  }
  const maxAttempts = 1 + MCP_HTTP.requestRetries;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { res, text } = await fetchTextWithTimeout(
        url,
        { method: "POST", headers, body: JSON.stringify(data) },
        MCP_HTTP.requestTimeoutMs
      );
      const body = parseJsonBestEffort(text);
      if (!res.ok) {
        const msg = body && typeof body === "object" ? String(body.error || body.message || "").trim() : "";
        return {
          success: false,
          action,
          httpStatus: res.status,
          httpStatusText: res.statusText,
          error: msg || `HTTP ${res.status} ${res.statusText}`,
          body
        };
      }
      return body;
    } catch (error) {
      lastHealthOkAt = 0;
      const msg = error?.name === "AbortError" ? `Request timeout after ${MCP_HTTP.requestTimeoutMs}ms` : error?.message || String(error);
      if (attempt >= maxAttempts) {
        return {
          success: false,
          action,
          httpStatus: null,
          httpStatusText: "",
          error: msg,
          body: {
            karinUrl: MCP_CONFIG.karinUrl,
            url,
            attempt,
            maxAttempts
          }
        };
      }
      const backoff = MCP_HTTP.retryBackoffMs > 0 ? MCP_HTTP.retryBackoffMs * attempt : 0;
      if (backoff) await sleep(backoff);
      try {
        await waitForBridgeReady();
      } catch {
      }
    }
  }
};
var MCP_TOOLS = {
  bot_status: {
    name: "bot_status",
    description: "\u83B7\u53D6 Karin \u8FD0\u884C\u72B6\u6001\u4E0E MCP \u63D2\u4EF6\u72B6\u6001",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  "action.call": {
    name: "action.call",
    description: "\u8C03\u7528\u4EFB\u610F HTTP action\uFF08\u767D\u540D\u5355/\u6743\u9650\u7531 Karin \u7AEF\u63A7\u5236\uFF09",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "HTTP action \u540D\u79F0\uFF08\u4F8B\u5982 bot.status\uFF09" },
        data: { type: "object", description: "\u8BF7\u6C42\u4F53 JSON\uFF08\u53EF\u9009\uFF09" }
      },
      required: ["action"]
    }
  },
  "action.list": {
    name: "action.list",
    description: "\u5217\u51FA Karin \u7AEF\u53EF\u7528 actions\uFF08meta.actions\uFF09",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  mock_incoming_message: {
    name: "mock_incoming_message",
    description: "LLM \u2192 Bot \u6CE8\u5165\u5165\u7AD9\u6D88\u606F\uFF08\u5E26 group_id \u89C6\u4E3A\u7FA4\u804A\uFF09\uFF0C\u652F\u6301 waitMs + traceId",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        user_id: { type: "string" },
        group_id: { type: "string" },
        nickname: { type: "string" },
        role: { type: "string", enum: ["member", "admin", "owner"] },
        waitMs: { type: "number" },
        traceId: { type: "string" }
      },
      required: ["message", "user_id"]
    }
  },
  mock_status: {
    name: "mock_status",
    description: "\u67E5\u770B Mock \u73AF\u5883\u7EDF\u8BA1\uFF08inbox/outbox/trace \u6570\u91CF\uFF09",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  mock_history: {
    name: "mock_history",
    description: "\u67E5\u770B Mock \u6536\u53D1\u5386\u53F2\uFF08type=in/out\uFF0C\u53EF\u9009 limit\uFF09",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["in", "out"] },
        limit: { type: "number" }
      },
      required: []
    }
  },
  render_screenshot: {
    name: "render_screenshot",
    description: "\u901A\u8FC7 Karin \u6E32\u67D3\u5668\u622A\u56FE\uFF08\u8FD4\u56DE url / filePath\uFF09",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "URL / \u672C\u5730\u8DEF\u5F84 / HTML \u5B57\u7B26\u4E32" },
        file_type: { type: "string", enum: ["auto", "htmlString", "vue3", "vueString", "react"], description: "If file is HTML string, prefer htmlString (or omit for auto-detect)." },
        type: { type: "string", enum: ["png", "jpeg", "webp"] },
        filename: { type: "string" },
        return: { type: "string", enum: ["url", "filePath", "both"] },
        echoFile: { type: "boolean", description: "Echo input file (truncated). Default false for low-token." },
        fullPage: { type: "boolean" },
        multiPage: { anyOf: [{ type: "boolean" }, { type: "number" }] },
        setViewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
            deviceScaleFactor: { type: "number" }
          }
        },
        pageGotoParams: { type: "object" },
        headers: { type: "object" },
        data: { type: "object" }
      },
      required: ["file"]
    }
  }
};
if (MCP_FLAGS.configRead) {
  MCP_TOOLS["status"] = {
    name: "status",
    description: "\u83B7\u53D6 Karin/MCP \u8FD0\u884C\u72B6\u6001\uFF08\u7B49\u4EF7\u4E8E bot_status\uFF09",
    inputSchema: { type: "object", properties: {}, required: [] }
  };
  MCP_TOOLS["config.get"] = {
    name: "config.get",
    description: "\u8BFB\u53D6 Karin MCP \u63D2\u4EF6\u914D\u7F6E\uFF08\u53EA\u8BFB\uFF09\u3002\u9700\u5728 Karin \u7AEF\u5F00\u542F mcpTools.configRead",
    inputSchema: { type: "object", properties: {}, required: [] }
  };
}
MCP_TOOLS.quick_status = {
  name: "quick_status",
  description: "Compact status summary (low token).",
  inputSchema: { type: "object", properties: {}, required: [] }
};
MCP_TOOLS.send_message = {
  name: "send_message",
  description: "Send a test message (defaults user_id/nickname/waitMs; returns compact summary).",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      user_id: { type: "string" },
      group_id: { type: "string" },
      nickname: { type: "string" },
      role: { type: "string", enum: ["member", "admin", "owner"] },
      waitMs: { type: "number" },
      traceId: { type: "string" }
    },
    required: ["message"]
  }
};
MCP_TOOLS["scenario.list"] = {
  name: "scenario.list",
  description: "List builtin test scenarios (low token).",
  inputSchema: { type: "object", properties: {}, required: [] }
};
MCP_TOOLS["scenario.run"] = {
  name: "scenario.run",
  description: "Run one builtin scenario (records JSON traces).",
  inputSchema: {
    type: "object",
    properties: {
      scenarioId: { type: "string" },
      sessionId: { type: "string" },
      defaults: { type: "object" }
    },
    required: ["scenarioId"]
  }
};
MCP_TOOLS["scenario.run_all"] = {
  name: "scenario.run_all",
  description: "Run all builtin scenarios (records JSON traces).",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      defaults: { type: "object" }
    },
    required: []
  }
};
MCP_TOOLS["records.list"] = {
  name: "records.list",
  description: "List JSON test record files (http/sessions/traces).",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string" },
      limit: { type: "number" }
    },
    required: []
  }
};
MCP_TOOLS["records.tail"] = {
  name: "records.tail",
  description: "Tail JSONL test records for a date (kind=http|sessions).",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["http", "sessions"] },
      date: { type: "string" },
      limit: { type: "number" },
      traceId: { type: "string", description: "Optional filter for kind=sessions" }
    },
    required: []
  }
};
MCP_TOOLS["trace.get"] = {
  name: "trace.get",
  description: "Read a trace record (by date/file or traceId).",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string" },
      file: { type: "string" },
      traceId: { type: "string" }
    },
    required: []
  }
};
var MCP_RESOURCES = {
  "karin://mcp/overview.md": {
    uri: "karin://mcp/overview.md",
    name: "Karin MCP Overview",
    description: "HTTP Bridge / MCP Server \u57FA\u672C\u4FE1\u606F\u4E0E\u5FEB\u901F\u4E0A\u624B",
    mimeType: "text/markdown",
    getText: () => {
      return [
        `# Karin MCP Bridge`,
        "",
        `- MCP(stdio) server: \`${MCP_CONFIG.name}@${MCP_CONFIG.version}\``,
        `- HTTP bridge: \`${MCP_CONFIG.karinUrl}\``,
        `- Auth: disabled (IP allowlist optional)`,
        "",
        "## HTTP endpoints",
        `- GET ${MCP_CONFIG.karinUrl}/health`,
        `- GET ${MCP_CONFIG.karinUrl}/files/:filename`,
        `- POST ${MCP_CONFIG.karinUrl}/api/bot.status`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.incoming.message`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.status`,
        `- POST ${MCP_CONFIG.karinUrl}/api/mock.history`,
        `- POST ${MCP_CONFIG.karinUrl}/api/render.screenshot`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenarios.list`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenario.run`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.scenarios.runAll`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.records.list`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.records.tail`,
        `- POST ${MCP_CONFIG.karinUrl}/api/test.trace.get`,
        "",
        "## Notes",
        "- If `mcpPath` changes, the old path returns HTTP 410 with the new `activePath`.",
        "- JSON test logs are stored under `@karinjs/<plugin>/data/mcp-test` (http/sessions/traces/runs).",
        "- Recommended MCP tools: `quick_status`, `send_message`, `scenario.run_all`.",
        "- Chat commands are read-only: `#mcp \u5E2E\u52A9` / `#mcp \u914D\u7F6E` / `#mcp \u72B6\u6001` / `#mcp \u5BFC\u51FA\u914D\u7F6E`. For configuration changes, use Web UI (`web.config`)."
      ].join("\n");
    }
  },
  "karin://mcp/ide-snippet.json": {
    uri: "karin://mcp/ide-snippet.json",
    name: "IDE Client Snippet",
    description: "\u793A\u4F8B\uFF1A\u7ED9 MCP Host \u7684\u73AF\u5883\u53D8\u91CF\u7247\u6BB5\uFF08\u6309\u4F60\u7684\u5BBF\u4E3B\u683C\u5F0F\u8C03\u6574\uFF09",
    mimeType: "application/json",
    getText: () => JSON.stringify({
      command: "node",
      args: [
        process.argv[1] || "path/to/mcp-server.js",
        "--karin-url",
        MCP_CONFIG.karinUrl,
        MCP_FLAGS.configRead ? "--config-read" : "--no-config-read"
      ]
    }, null, 2)
  },
  "karin://mcp/troubleshooting.md": {
    uri: "karin://mcp/troubleshooting.md",
    name: "Troubleshooting",
    description: "\u5E38\u89C1\u95EE\u9898\u6392\u67E5\uFF1A403/410/\u65E0\u56DE\u590D/\u6E32\u67D3\u5931\u8D25",
    mimeType: "text/markdown",
    getText: () => [
      "# Troubleshooting",
      "",
      "## 403 Forbidden (IP allowlist)",
      "- Your IP is not in allowlist. Check `security.ipAllowlist` in Web UI config.",
      "",
      "## 410 Gone (mcpPath changed)",
      "- Your configured URL is outdated. Use the `activePath` returned by the 410 response, or check `#mcp \u914D\u7F6E`.",
      "",
      "## No reply / empty responses",
      "- Try `quick_status` (or `bot_status`) to confirm plugin is alive.",
      "- Use `send_message` (or `mock_incoming_message`) with a new `traceId` and increase `waitMs`.",
      "",
      "## Render failures",
      "- `render_screenshot` accepts URL/local path/HTML string; try `file_type=htmlString` for inline HTML."
    ].join("\n")
  }
};
var MCP_PROMPTS = {
  inject_message: {
    name: "inject_message",
    description: "\u6CE8\u5165\u4E00\u6761\u6D88\u606F\u5230 Karin\uFF08send_message\uFF09\uFF0C\u5E76\u89E3\u91CA traceId/\u805A\u5408\u56DE\u590D\u7528\u6CD5",
    arguments: [
      { name: "message", description: "\u8981\u53D1\u9001\u7684\u5185\u5BB9", required: true },
      { name: "user_id", description: "user_id\uFF08\u53EF\u9009\uFF1B\u7559\u7A7A\u4F7F\u7528\u9ED8\u8BA4\uFF09" },
      { name: "group_id", description: "\u7FA4 ID\uFF08\u53EF\u9009\uFF1B\u4F20\u4E86\u5C31\u89C6\u4E3A\u7FA4\u804A\uFF09" }
    ],
    getMessages: (args) => {
      const message = String(args.message || "").trim();
      const userId = String(args.user_id || "").trim();
      const groupId = String(args.group_id || "").trim();
      const payload = {
        message,
        user_id: userId || void 0,
        group_id: groupId || void 0,
        waitMs: 1200
      };
      return [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "\u8BF7\u4F7F\u7528 `send_message` \u5DE5\u5177\u628A\u4E0B\u9762\u8FD9\u6761\u6D88\u606F\u6CE8\u5165 Karin\uFF0C\u5E76\u6839\u636E\u8FD4\u56DE\u7684 `replies/traceId` \u6C47\u603B\u56DE\u590D\u3002",
                "",
                "\u63D0\u793A\uFF1A",
                "- user_id \u53EF\u4EE5\u4E0D\u4F20\uFF0C\u5DE5\u5177\u4F1A\u586B\u9ED8\u8BA4\u503C\u3002",
                "- traceId \u53EF\u4EE5\u4E0D\u4F20\uFF0C\u8BA9\u670D\u52A1\u7AEF\u81EA\u52A8\u751F\u6210\u3002",
                "- \u5982\u679C\u56DE\u590D\u8F83\u6162\uFF0C\u53EF\u4EE5\u628A waitMs \u63D0\u9AD8\u5230 3000-8000\u3002",
                "- \u9700\u8981\u7ED3\u6784\u5316\u6D88\u606F\u6BB5\uFF08\u56FE\u7247/\u5361\u7247\u7B49\uFF09\u65F6\uFF0C\u4F7F\u7528\u8FD4\u56DE\u7684 `messages`\uFF08elements JSON\uFF09\u3002",
                "- \u5386\u53F2\u4F1A\u8BDD\u9ED8\u8BA4\u4E0D\u56DE\u4F20\uFF1A\u7528 `records.tail`\uFF08kind=sessions, traceId=...\uFF09\u81EA\u884C\u67E5\u8BE2\u3002",
                "",
                `\u53C2\u6570\uFF1A
${JSON.stringify(payload, null, 2)}`
              ].join("\n")
            }
          ]
        }
      ];
    }
  },
  debug_auth_path: {
    name: "debug_auth_path",
    description: "\u6392\u67E5 IP \u767D\u540D\u5355\u4E0E mcpPath \u53D8\u66F4\uFF08403/410\uFF09",
    getMessages: () => [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "\u8BF7\u6309\u4EE5\u4E0B\u6B65\u9AA4\u6392\u67E5\uFF1A",
              `1) \u8C03\u7528 quick_status\uFF08\u6216 bot_status\uFF09\u786E\u8BA4\u670D\u52A1\u53EF\u7528\uFF1B`,
              `2) \u5982\u679C\u51FA\u73B0 403\uFF1A\u68C0\u67E5 Web UI \u914D\u7F6E security.ipAllowlist\uFF08IP/CIDR \u767D\u540D\u5355\uFF09\uFF1B`,
              `3) \u5982\u679C\u51FA\u73B0 410\uFF1A\u8BF4\u660E mcpPath \u5DF2\u53D8\u66F4\uFF0C\u4F7F\u7528\u54CD\u5E94\u4E2D\u7684 activePath \u66F4\u65B0\u4F60\u7684 URL\uFF1B`,
              `4) \u5982\u4ECD\u5931\u8D25\uFF0C\u5C1D\u8BD5\u5728 Karin \u804A\u5929\u4E2D\u53D1\u9001\uFF1A#mcp \u914D\u7F6E / #mcp \u72B6\u6001 \u67E5\u770B\u5B9E\u65F6\u4FE1\u606F\u3002`
            ].join("\n")
          }
        ]
      }
    ]
  }
};
var toSafeLogData = (value, keyHint = "") => {
  const key = keyHint.toLowerCase();
  if (typeof value === "string") {
    if (key.includes("apikey")) return "[redacted]";
    if (value.length > 200) return `${value.slice(0, 200)}\u2026`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => toSafeLogData(v));
  }
  if (value && typeof value === "object") {
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = toSafeLogData(v, k);
    }
    return obj;
  }
  return value;
};
var executeTool = async (name, args) => {
  log("info", `Executing tool: ${name}`, args ? toSafeLogData(args) : null);
  const asStr = (value) => String(value ?? "").trim();
  const asNum = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const compactStatus = (result) => {
    if (!result || typeof result !== "object") return result;
    if (result.success === false) return result;
    const d = result.data ?? {};
    return {
      success: true,
      action: result.action || "bot.status",
      data: {
        mcpPath: d?.mcpPath ?? null,
        mcpServer: d?.mcpServer ?? null,
        adapter: d?.adapter ?? null,
        buffers: d?.buffers ?? null
      },
      time: result.time ?? Date.now()
    };
  };
  const compactIncoming = (result) => {
    if (!result || typeof result !== "object") return result;
    if (result.success === false) return result;
    const d = result.data ?? {};
    const responses = Array.isArray(d?.responses) ? d.responses : [];
    const replies = responses.map((r) => asStr(r?.msg)).filter(Boolean).slice(0, 8);
    const messages = responses.slice(0, 8).map((r) => ({
      time: r?.time ?? null,
      messageId: r?.messageId ?? null,
      kind: r?.kind ?? null,
      msg: asStr(r?.msg) || null,
      elements: toSafeLogData(r?.elements, "elements")
    }));
    return {
      success: true,
      action: result.action || "mock.incoming.message",
      data: {
        traceId: d?.traceId ?? null,
        replyCount: responses.length,
        replies,
        messages,
        traceFile: d?.traceFile ?? null,
        sessionFile: d?.sessionFile ?? null
      },
      time: result.time ?? Date.now()
    };
  };
  const compactScenarioRun = (result) => {
    if (!result || typeof result !== "object") return result;
    if (result.success === false) return result;
    const d = result.data ?? {};
    const steps = Array.isArray(d?.steps) ? d.steps : [];
    const failed = steps.filter((s) => s && s.ok === false).slice(0, 6).map((s) => ({
      name: s?.name ?? null,
      target: s?.target ?? null,
      status: s?.status ?? null,
      error: s?.error ?? null
    }));
    return {
      success: true,
      action: result.action,
      data: {
        sessionId: d?.sessionId ?? null,
        scenarioId: d?.scenarioId ?? null,
        title: d?.title ?? null,
        ok: d?.ok ?? null,
        durationMs: d?.durationMs ?? null,
        stepCount: steps.length,
        failed,
        runFile: d?.runFile ?? null
      },
      time: result.time ?? Date.now()
    };
  };
  const compactScenarioSuite = (result) => {
    if (!result || typeof result !== "object") return result;
    if (result.success === false) return result;
    const d = result.data ?? {};
    const scenarios = Array.isArray(d?.scenarios) ? d.scenarios : [];
    const failed = scenarios.filter((s) => s && s.ok === false).slice(0, 10).map((s) => s?.scenarioId ?? null);
    return {
      success: true,
      action: result.action,
      data: {
        sessionId: d?.sessionId ?? null,
        ok: d?.ok ?? null,
        durationMs: d?.durationMs ?? null,
        scenarioCount: scenarios.length,
        failed,
        runFile: d?.runFile ?? null
      },
      time: result.time ?? Date.now()
    };
  };
  switch (name) {
    case "bot_status":
      return await makeRequest("bot.status");
    case "status":
      return await makeRequest("bot.status");
    case "quick_status":
      return compactStatus(await makeRequest("bot.status"));
    case "action.call": {
      const action = String(args?.action || "").trim();
      if (!action) throw new Error("action.call: action is required");
      const data = args?.data && typeof args.data === "object" ? args.data : {};
      return await makeRequest(action, data);
    }
    case "action.list":
      return await makeRequest("meta.actions");
    case "scenario.list":
      return await makeRequest("test.scenarios.list");
    case "scenario.run": {
      const scenarioId = asStr(args?.scenarioId || args?.id);
      if (!scenarioId) throw new Error("scenario.run: scenarioId is required");
      const sessionId = asStr(args?.sessionId) || void 0;
      const defaults = args?.defaults && typeof args.defaults === "object" ? args.defaults : void 0;
      return compactScenarioRun(await makeRequest("test.scenario.run", { scenarioId, sessionId, defaults }));
    }
    case "scenario.run_all": {
      const sessionId = asStr(args?.sessionId) || void 0;
      const defaults = args?.defaults && typeof args.defaults === "object" ? args.defaults : void 0;
      return compactScenarioSuite(await makeRequest("test.scenarios.runAll", { sessionId, defaults }));
    }
    case "records.list": {
      const date = asStr(args?.date) || void 0;
      const limit = asNum(args?.limit, 50);
      return await makeRequest("test.records.list", { date, limit });
    }
    case "records.tail": {
      const date = asStr(args?.date) || void 0;
      const limit = asNum(args?.limit, 20);
      const kind = asStr(args?.kind) || void 0;
      const traceId = asStr(args?.traceId) || void 0;
      return await makeRequest("test.records.tail", { kind, date, limit, traceId });
    }
    case "trace.get": {
      const date = asStr(args?.date) || void 0;
      const file = asStr(args?.file) || void 0;
      const traceId = asStr(args?.traceId) || void 0;
      return await makeRequest("test.trace.get", { date, file, traceId });
    }
    case "send_message": {
      const message = asStr(args?.message);
      if (!message) throw new Error("send_message: message is required");
      const payload = {
        message,
        user_id: asStr(args?.user_id) || "mcp-test-user",
        group_id: asStr(args?.group_id) || void 0,
        nickname: asStr(args?.nickname) || "MCP Tester",
        role: asStr(args?.role) || "member",
        waitMs: asNum(args?.waitMs, 1200),
        traceId: asStr(args?.traceId) || crypto.randomUUID()
      };
      return compactIncoming(await makeRequest("mock.incoming.message", payload));
    }
    case "mock_incoming_message":
      return await makeRequest("mock.incoming.message", args || {});
    case "mock_status":
      return await makeRequest("mock.status");
    case "mock_history":
      return await makeRequest("mock.history", args || {});
    case "render_screenshot":
      return await makeRequest("render.screenshot", args || {});
    case "config.get":
      return await makeRequest("config.get");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};
var MCPServer = class {
  initialized = false;
  sendResponse(id, result = null, error = null) {
    const response = { jsonrpc: "2.0", id };
    if (error) {
      response.error = {
        code: error.code || -32e3,
        message: error.message || "Unknown error",
        data: error.data
      };
    } else {
      response.result = result;
    }
    process.stdout.write(`${JSON.stringify(response)}
`);
  }
  sendNotification(method, params = {}) {
    const notification = { jsonrpc: "2.0", method, params };
    process.stdout.write(`${JSON.stringify(notification)}
`);
  }
  async handleInitialize(id, params) {
    log("info", "MCP Server initializing", params);
    this.sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {}
      },
      serverInfo: { name: MCP_CONFIG.name, version: MCP_CONFIG.version }
    });
  }
  async handleListTools(id) {
    this.sendResponse(id, { tools: Object.values(MCP_TOOLS) });
  }
  async handleCallTool(id, params) {
    try {
      const { name, arguments: args } = params || {};
      if (!MCP_TOOLS[name]) throw new Error(`Tool not found: ${name}`);
      const finalArgs = args || {};
      if (name === "mock_incoming_message" && !finalArgs.traceId) {
        finalArgs.traceId = crypto.randomUUID();
      }
      const result = await executeTool(name, finalArgs);
      this.sendResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result) }]
      });
    } catch (error) {
      this.sendResponse(id, null, { code: -32e3, message: error?.message || String(error) });
    }
  }
  async handleListResources(id) {
    const resources = Object.values(MCP_RESOURCES).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType
    }));
    this.sendResponse(id, { resources });
  }
  async handleReadResource(id, params) {
    try {
      const uri = String(params?.uri || "").trim();
      const spec = MCP_RESOURCES[uri];
      if (!spec) throw new Error(`Resource not found: ${uri}`);
      const text = await spec.getText();
      this.sendResponse(id, {
        contents: [
          {
            uri: spec.uri,
            mimeType: spec.mimeType || "text/plain",
            text
          }
        ]
      });
    } catch (error) {
      this.sendResponse(id, null, { code: -32e3, message: error?.message || String(error) });
    }
  }
  async handleListPrompts(id) {
    const prompts = Object.values(MCP_PROMPTS).map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments || []
    }));
    this.sendResponse(id, { prompts });
  }
  async handleGetPrompt(id, params) {
    try {
      const name = String(params?.name || "").trim();
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const spec = MCP_PROMPTS[name];
      if (!spec) throw new Error(`Prompt not found: ${name}`);
      const messages = spec.getMessages(args);
      this.sendResponse(id, { description: spec.description, messages });
    } catch (error) {
      this.sendResponse(id, null, { code: -32e3, message: error?.message || String(error) });
    }
  }
  async handleMessage(message) {
    try {
      const { id, method, params } = message;
      switch (method) {
        case "initialize":
          await this.handleInitialize(id, params);
          break;
        case "notifications/initialized":
          this.initialized = true;
          break;
        case "tools/list":
          await this.handleListTools(id);
          break;
        case "tools/call":
          await this.handleCallTool(id, params);
          break;
        case "resources/list":
          await this.handleListResources(id);
          break;
        case "resources/read":
          await this.handleReadResource(id, params);
          break;
        case "prompts/list":
          await this.handleListPrompts(id);
          break;
        case "prompts/get":
          await this.handleGetPrompt(id, params);
          break;
        default:
          if (id !== void 0 && id !== null) {
            this.sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
          }
      }
    } catch (error) {
      log("error", "Message handling failed", { error: error?.message || String(error), message });
      if (message?.id !== void 0 && message?.id !== null) {
        this.sendResponse(message.id, null, { code: -32e3, message: error?.message || String(error) });
      }
    }
  }
  start() {
    log("info", "MCP Server starting", { ...MCP_CONFIG });
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          void this.handleMessage(message);
        } catch (error) {
          log("error", "JSON parse error", { error: error?.message || String(error), line });
        }
      }
    });
    process.stdin.on("end", () => {
      log("info", "MCP Server stdin ended, exit");
      process.exit(0);
    });
    process.on("uncaughtException", (error) => {
      log("error", "Uncaught exception", { error: error?.message || String(error), stack: error?.stack });
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      log("error", "Unhandled rejection", { reason });
      process.exit(1);
    });
    log("info", "MCP Server ready");
  }
};
var isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();
if (isMain) {
  new MCPServer().start();
}
var mcp_server_default = MCPServer;
export {
  mcp_server_default as default
};
