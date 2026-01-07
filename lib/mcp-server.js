// src/mcp-server.ts
import crypto from "crypto";
import { pathToFileURL } from "url";
var ENV = process.env;
var baseUrl = ENV.KARIN_MCP_URL ? ENV.KARIN_MCP_URL : `${ENV.KARIN_BASE_URL || "http://127.0.0.1:7777"}${ENV.KARIN_MCP_PATH || "/MCP"}`;
var MCP_CONFIG = {
  name: "karin-mcp",
  version: "0.2.0",
  description: "Karin Bot MCP Server",
  karinUrl: baseUrl,
  apiKey: ENV.KARIN_MCP_API_KEY || ENV.HTTP_AUTH_KEY || ""
};
var log = (level, message, data = null) => {
  const entry = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    message,
    data
  };
  process.stderr.write(`${JSON.stringify(entry)}
`);
};
var makeRequest = async (action, data = {}) => {
  const url = `${MCP_CONFIG.karinUrl}/api/${action}`;
  const headers = { "Content-Type": "application/json" };
  if (MCP_CONFIG.apiKey) headers["X-API-Key"] = MCP_CONFIG.apiKey;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return await res.json();
};
var MCP_TOOLS = {
  bot_status: {
    name: "bot_status",
    description: "\u83B7\u53D6 Karin \u8FD0\u884C\u72B6\u6001\u4E0E MCP \u63D2\u4EF6\u72B6\u6001",
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
        file_type: { type: "string", enum: ["auto", "htmlString", "vue3", "vueString", "react"] },
        type: { type: "string", enum: ["png", "jpeg", "webp"] },
        filename: { type: "string" },
        return: { type: "string", enum: ["url", "filePath", "both"] },
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
var executeTool = async (name, args) => {
  log("info", `Executing tool: ${name}`, args || null);
  switch (name) {
    case "bot_status":
      return await makeRequest("bot.status");
    case "mock_incoming_message":
      return await makeRequest("mock.incoming.message", args || {});
    case "mock_status":
      return await makeRequest("mock.status");
    case "mock_history":
      return await makeRequest("mock.history", args || {});
    case "render_screenshot":
      return await makeRequest("render.screenshot", args || {});
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
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: { name: MCP_CONFIG.name, version: MCP_CONFIG.version }
    });
    this.initialized = true;
    this.sendNotification("notifications/initialized");
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
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      });
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
        case "tools/list":
          await this.handleListTools(id);
          break;
        case "tools/call":
          await this.handleCallTool(id, params);
          break;
        default:
          this.sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (error) {
      log("error", "Message handling failed", { error: error?.message || String(error), message });
      if (message?.id) this.sendResponse(message.id, null, { code: -32e3, message: error?.message || String(error) });
    }
  }
  start() {
    log("info", "MCP Server starting", MCP_CONFIG);
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
