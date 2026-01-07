import {
  clamp,
  getEffectiveApiKey,
  getEffectiveMcpPath,
  getLocalBaseUrl,
  sleep,
  toNum,
  toStr
} from "./chunk-PDBPKRSW.js";
import {
  dir
} from "./chunk-NF24Q4FD.js";

// src/index.ts
import { logger as logger3 } from "node-karin";

// src/mcp/init.ts
import express from "node-karin/express";
import { app, logger as logger2 } from "node-karin";

// src/mcp/impl.ts
import { spawn } from "child_process";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import {
  contactFriend,
  contactGroup,
  createFriendMessage,
  createGroupMessage,
  fileToUrl,
  getAllBot,
  logger,
  registerBot,
  render,
  senderFriend,
  senderGroup,
  segment,
  unregisterBot
} from "node-karin";

// src/mcp/auth.ts
var getReqApiKey = (req) => {
  const header = toStr(req.headers["x-api-key"]).trim();
  if (header) return header;
  const authorization = toStr(req.headers.authorization).trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }
  const queryKey = toStr(req.query?.apiKey).trim();
  if (queryKey) return queryKey;
  const bodyKey = toStr(req.body?.apiKey).trim();
  if (bodyKey) return bodyKey;
  return "";
};
var isAuthorized = (req, apiKey) => {
  if (!apiKey) return true;
  return getReqApiKey(req) === apiKey;
};

// src/mcp/adapter/mcpAdapter.ts
import { AdapterBase, createRawMessage } from "node-karin";
var MAX_HISTORY = 200;
var McpAdapter = class extends AdapterBase {
  impl;
  constructor(impl) {
    super();
    this.impl = impl;
    const now = Date.now();
    this.adapter.name = "karin-mcp";
    this.adapter.communication = "other";
    this.adapter.platform = "other";
    this.adapter.standard = "other";
    this.adapter.protocol = "other";
    this.adapter.version = String(process.env.KARIN_VERSION || "unknown");
    this.adapter.address = "internal://karin-mcp";
    this.adapter.connectTime = now;
    this.adapter.secret = null;
    this.account.name = "mcp";
    this.account.uid = "mcp";
    this.account.uin = "mcp";
    this.account.selfId = "mcp";
    this.account.avatar = "https://p.qlogo.cn/gh/967068507/967068507/0";
  }
  get selfId() {
    return this.account.selfId;
  }
  async sendMsg(contact, elements) {
    const time = Date.now();
    const messageId = `${time}_${Math.random().toString(36).slice(2)}`;
    const traceId = this.impl.traceStorage.getStore()?.traceId ?? null;
    const { raw, msg } = createRawMessage(elements);
    const record = {
      direction: "out",
      traceId,
      time,
      messageId,
      contact,
      elements,
      raw,
      msg
    };
    this.impl.outbox.unshift(record);
    if (this.impl.outbox.length > MAX_HISTORY) this.impl.outbox.length = MAX_HISTORY;
    if (traceId && this.impl.traces.has(traceId)) {
      this.impl.traces.get(traceId).responses.push(record);
    }
    return {
      message_id: messageId,
      messageId,
      time,
      messageTime: time,
      rawData: record
    };
  }
  async sendForwardMsg(contact, elements, options) {
    const time = Date.now();
    const messageId = `${time}_${Math.random().toString(36).slice(2)}`;
    const traceId = this.impl.traceStorage.getStore()?.traceId ?? null;
    const record = {
      direction: "out",
      kind: "forward",
      traceId,
      time,
      messageId,
      contact,
      elements,
      options
    };
    this.impl.outbox.unshift(record);
    if (this.impl.outbox.length > MAX_HISTORY) this.impl.outbox.length = MAX_HISTORY;
    if (traceId && this.impl.traces.has(traceId)) {
      this.impl.traces.get(traceId).responses.push(record);
    }
    return { messageId, forwardId: messageId };
  }
  async getAvatarUrl() {
    return this.account.avatar;
  }
  async getGroupAvatarUrl() {
    return this.account.avatar;
  }
  async recallMsg() {
    return;
  }
};

// src/mcp/impl.ts
var MAX_HISTORY2 = 200;
var TRACE_TTL_MS = 5 * 60 * 1e3;
var resolveMcpServerLaunch = () => {
  const pluginDir = dir.pluginDir;
  const distPath = path.join(pluginDir, "lib", "mcp-server.js");
  if (existsSync(distPath)) return { args: [distPath], cwd: pluginDir };
  const srcPath = path.join(pluginDir, "src", "mcp-server.ts");
  return { args: ["--import", "tsx", srcPath], cwd: pluginDir };
};
var createMcpImpl = (options) => {
  const { mcpPath, pluginName } = options;
  const traceStorage = new AsyncLocalStorage();
  const traces = /* @__PURE__ */ new Map();
  const inbox = [];
  const outbox = [];
  const apiKey = getEffectiveApiKey();
  const renderDir = path.join(dir.karinPath, "data", "mcp-render");
  let mcpProcess = null;
  let adapter = null;
  let adapterIndex = null;
  const startMcpServerProcess = () => {
    if (mcpProcess) return;
    const baseUrl = getLocalBaseUrl();
    const mcpUrl = `${baseUrl}${mcpPath}`;
    const { args, cwd } = resolveMcpServerLaunch();
    try {
      mcpProcess = spawn(process.execPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          KARIN_BASE_URL: baseUrl,
          KARIN_MCP_PATH: mcpPath,
          KARIN_MCP_URL: mcpUrl,
          KARIN_MCP_API_KEY: apiKey
        }
      });
      mcpProcess.stdout.on("data", (data) => {
        const text = data.toString().trim();
        if (text) logger.debug(`[${pluginName} mcp-server] stdout: ${text}`);
      });
      mcpProcess.stderr.on("data", (data) => {
        const text = data.toString();
        text.split("\n").map((line) => line.trim()).filter(Boolean).forEach((line) => {
          try {
            const entry = JSON.parse(line);
            const level = toStr(entry.level || "info").toLowerCase();
            const msg = toStr(entry.message || line);
            if (level === "error") logger.error(`[${pluginName} mcp-server] ${msg}`);
            else if (level === "warn") logger.warn(`[${pluginName} mcp-server] ${msg}`);
            else logger.info(`[${pluginName} mcp-server] ${msg}`);
          } catch {
            logger.debug(`[${pluginName} mcp-server] stderr: ${line}`);
          }
        });
      });
      mcpProcess.on("close", (code) => {
        logger.warn(`[${pluginName}] mcp-server exited: ${code}`);
        mcpProcess = null;
      });
      mcpProcess.on("error", (error) => {
        logger.error(`[${pluginName}] mcp-server error: ${error?.message || error}`);
        mcpProcess = null;
      });
      logger.mark(`[${pluginName}] mcp-server spawned (pid=${mcpProcess.pid})`);
    } catch (error) {
      logger.error(`[${pluginName}] spawn mcp-server failed: ${error?.message || error}`);
      mcpProcess = null;
    }
  };
  const stopMcpServerProcess = async () => {
    if (!mcpProcess) return;
    try {
      mcpProcess.kill("SIGTERM");
    } catch {
    } finally {
      mcpProcess = null;
    }
  };
  const registerAdapter = () => {
    adapter = new McpAdapter({ traceStorage, traces, inbox, outbox });
    adapterIndex = registerBot("other", adapter);
    logger.mark(`[${pluginName}] adapter registered: selfId=${adapter.selfId}, index=${adapterIndex}`);
  };
  const unregisterAdapter = () => {
    if (!adapter) return;
    try {
      unregisterBot("selfId", adapter.selfId);
    } catch (error) {
      logger.debug(`[${pluginName}] unregisterBot failed: ${error?.message || error}`);
    } finally {
      adapter = null;
      adapterIndex = null;
    }
  };
  const handleHealth = (_req, res) => {
    res.json({
      status: "ok",
      plugin: pluginName,
      mcpPath,
      time: Date.now(),
      mcpServer: {
        running: Boolean(mcpProcess),
        pid: mcpProcess?.pid ?? null
      },
      adapter: {
        selfId: adapter?.selfId ?? null,
        index: adapterIndex
      }
    });
  };
  const handleFile = (req, res) => {
    if (!isAuthorized(req, apiKey)) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
    const filename = toStr(req.params?.filename).trim();
    if (!filename) {
      res.status(400).json({ success: false, error: "filename \u4E0D\u80FD\u4E3A\u7A7A" });
      return;
    }
    const safe = path.basename(filename);
    if (safe !== filename) {
      res.status(400).json({ success: false, error: "filename \u975E\u6CD5" });
      return;
    }
    const filePath = path.join(renderDir, safe);
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: "file not found" });
      return;
    }
    res.sendFile(filePath);
  };
  const handleApi = async (req, res) => {
    const action = toStr(req.params?.action).trim();
    if (!isAuthorized(req, apiKey)) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }
    const data = req.method === "GET" ? req.query : req.body;
    try {
      switch (action) {
        case "bot.status": {
          res.json({
            success: true,
            action,
            data: {
              plugin: pluginName,
              mcpPath,
              http: { baseUrl: getLocalBaseUrl() },
              mcpServer: {
                running: Boolean(mcpProcess),
                pid: mcpProcess?.pid ?? null
              },
              adapter: {
                selfId: adapter?.selfId ?? null,
                index: adapterIndex
              },
              buffers: {
                traces: traces.size,
                inbox: inbox.length,
                outbox: outbox.length
              },
              bots: getAllBot().map((bot) => ({ selfId: bot.selfId, adapter: bot.adapter?.name }))
            },
            time: Date.now()
          });
          return;
        }
        case "mock.status": {
          res.json({
            success: true,
            action,
            data: {
              traces: traces.size,
              inbox: inbox.length,
              outbox: outbox.length
            },
            time: Date.now()
          });
          return;
        }
        case "mock.history": {
          const type = toStr(data?.type).trim();
          const limit = clamp(toNum(data?.limit, 50), 1, 200);
          const pick = (arr) => arr.slice(0, limit);
          res.json({
            success: true,
            action,
            data: type === "in" ? { inbox: pick(inbox) } : type === "out" ? { outbox: pick(outbox) } : { inbox: pick(inbox), outbox: pick(outbox) },
            time: Date.now()
          });
          return;
        }
        case "mock.incoming.message": {
          if (!adapter) throw new Error("MCP adapter not ready");
          const message = toStr(data?.message);
          const userId = toStr(data?.user_id).trim();
          const groupId = toStr(data?.group_id).trim();
          const nickname = toStr(data?.nickname).trim();
          const role = toStr(data?.role).trim() || "member";
          const waitMs = clamp(toNum(data?.waitMs, 1200), 0, 6e4);
          const traceId = toStr(data?.traceId).trim() || crypto.randomUUID();
          if (!message) throw new Error("message \u4E0D\u80FD\u4E3A\u7A7A");
          if (!userId) throw new Error("user_id \u4E0D\u80FD\u4E3A\u7A7A");
          const now = Date.now();
          const messageSeq = Math.floor(Math.random() * 1e9);
          const messageId = `${adapter.selfId}.${now}.${messageSeq}`;
          const contact = groupId ? contactGroup(groupId, "MCP Group") : contactFriend(userId, nickname || "MCP User");
          const sender = groupId ? senderGroup(userId, role, nickname || "MCP User") : senderFriend(userId, nickname || "MCP User");
          const elements = [segment.text(message)];
          const record = {
            direction: "in",
            traceId,
            time: now,
            messageId,
            messageSeq,
            userId,
            groupId: groupId || null,
            nickname: nickname || null,
            role: groupId ? role : null,
            message
          };
          inbox.unshift(record);
          if (inbox.length > MAX_HISTORY2) inbox.length = MAX_HISTORY2;
          traces.set(traceId, { createdAt: now, request: record, responses: [] });
          const timer = setTimeout(() => traces.delete(traceId), TRACE_TTL_MS);
          timer.unref?.();
          traceStorage.run({ traceId }, () => {
            const base = {
              bot: adapter,
              contact,
              sender,
              elements,
              eventId: messageId,
              messageId,
              messageSeq,
              rawEvent: { source: "mcp", traceId, data },
              time: now,
              srcReply: (els) => adapter.sendMsg(contact, els)
            };
            if (groupId) createGroupMessage(base);
            else createFriendMessage(base);
          });
          if (waitMs > 0) await sleep(waitMs);
          const responses = traces.get(traceId)?.responses ?? [];
          res.json({
            success: true,
            action,
            data: {
              traceId,
              injected: record,
              responses
            },
            time: Date.now()
          });
          return;
        }
        case "render.screenshot": {
          const file = toStr(data?.file).trim();
          const type = toStr(data?.type).trim() || "png";
          const fileType = toStr(data?.file_type).trim() || void 0;
          const filenameInput = toStr(data?.filename).trim();
          const returnMode = (toStr(data?.return).trim() || "url").toLowerCase();
          if (!file) throw new Error("file \u4E0D\u80FD\u4E3A\u7A7A");
          const ext = ["png", "jpeg", "webp"].includes(type) ? type : "png";
          const sanitizeFilename = (name) => {
            const base = path.basename(name).replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, "_");
            return base || `mcp-render.${ext}`;
          };
          const ensureExt = (name) => {
            const safe = sanitizeFilename(name);
            if (safe.toLowerCase().endsWith(`.${ext}`)) return safe;
            const parsed = path.parse(safe);
            return `${parsed.name}.${ext}`;
          };
          const baseFilename = filenameInput ? ensureExt(filenameInput) : `mcp-render-${Date.now()}.${ext}`;
          mkdirSync(renderDir, { recursive: true });
          const isHtmlString = fileType === "htmlString" || !fileType && file.trimStart().startsWith("<");
          const renderOptions = {
            name: "mcp-render",
            file: isHtmlString ? (() => {
              const parsed = path.parse(baseFilename);
              const htmlFilename = `${parsed.name}-${Date.now()}.html`;
              const htmlPath = path.join(renderDir, htmlFilename);
              writeFileSync(htmlPath, file, { encoding: "utf8" });
              return htmlPath;
            })() : file,
            type: ext,
            encoding: "base64"
          };
          if (fileType && !isHtmlString) renderOptions.file_type = fileType;
          if (typeof data?.multiPage === "number" || typeof data?.multiPage === "boolean") renderOptions.multiPage = data.multiPage;
          if (typeof data?.fullPage === "boolean") renderOptions.fullPage = data.fullPage;
          if (typeof data?.quality === "number") renderOptions.quality = data.quality;
          if (data?.headers && typeof data.headers === "object") renderOptions.headers = data.headers;
          if (data?.setViewport && typeof data.setViewport === "object") renderOptions.setViewport = data.setViewport;
          if (data?.pageGotoParams && typeof data.pageGotoParams === "object") renderOptions.pageGotoParams = data.pageGotoParams;
          if (data?.waitForSelector) renderOptions.waitForSelector = data.waitForSelector;
          if (data?.waitForFunction) renderOptions.waitForFunction = data.waitForFunction;
          if (data?.waitForRequest) renderOptions.waitForRequest = data.waitForRequest;
          if (data?.waitForResponse) renderOptions.waitForResponse = data.waitForResponse;
          if (data?.data && typeof data.data === "object") renderOptions.data = data.data;
          const rendered = await render.render(renderOptions);
          const images = Array.isArray(rendered) ? rendered : [rendered];
          const normalizeBase64 = (value) => value.startsWith("base64://") ? value.slice("base64://".length) : value;
          const results = await Promise.all(
            images.map(async (img, index) => {
              const base64 = normalizeBase64(String(img));
              const buffer = Buffer.from(base64, "base64");
              const filename = images.length === 1 ? baseFilename : (() => {
                const parsed = path.parse(baseFilename);
                return `${parsed.name}-${index + 1}${parsed.ext || `.${ext}`}`;
              })();
              const filePath = path.join(renderDir, filename);
              writeFileSync(filePath, buffer);
              let urlInfo = null;
              try {
                urlInfo = await fileToUrl("image", buffer, filename);
              } catch (error) {
                logger.warn(`[${pluginName}] fileToUrl failed: ${error?.message || error}`);
              }
              const fallbackUrl = (() => {
                const keyPart = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : "";
                return `${getLocalBaseUrl()}${mcpPath}/files/${encodeURIComponent(filename)}${keyPart}`;
              })();
              const url = urlInfo?.url ?? fallbackUrl;
              const width = urlInfo?.width ?? null;
              const height = urlInfo?.height ?? null;
              return {
                url: returnMode === "filepath" ? null : url,
                filePath: returnMode === "url" ? null : filePath,
                width,
                height,
                filename
              };
            })
          );
          res.json({
            success: true,
            action,
            data: {
              file,
              type: ext,
              count: results.length,
              results
            },
            time: Date.now()
          });
          return;
        }
        default: {
          res.status(404).json({ success: false, error: `Unknown action: ${action}` });
          return;
        }
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        action,
        error: error?.message || String(error),
        time: Date.now()
      });
    }
  };
  const dispose = async () => {
    unregisterAdapter();
    await stopMcpServerProcess();
  };
  registerAdapter();
  startMcpServerProcess();
  logger.mark(`[${pluginName}] ready: ${mcpPath} (apiKey=${apiKey ? "set" : "unset"})`);
  return { apiKey, handleHealth, handleApi, handleFile, dispose };
};

// src/mcp/init.ts
var GLOBAL_KEY = "__KARIN_PLUGIN_MCP__";
var ensureContainer = () => {
  const globalAny = globalThis;
  if (!globalAny[GLOBAL_KEY]) {
    globalAny[GLOBAL_KEY] = { mounted: false, router: null, impl: null };
  }
  return globalAny[GLOBAL_KEY];
};
var mountRoutesOnce = (container, mcpPath) => {
  if (container.mounted) return;
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));
  router.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    if (req.method === "OPTIONS") return res.status(200).end();
    next();
  });
  router.get("/health", (req, res) => container.impl?.handleHealth(req, res));
  router.get("/files/:filename", (req, res) => container.impl?.handleFile(req, res));
  router.all("/api/:action", (req, res) => container.impl?.handleApi(req, res));
  app.use(mcpPath, router);
  container.router = router;
  container.mounted = true;
  logger2.mark(`[${dir.name}] mounted: ${mcpPath}`);
};
var initMcpPlugin = async (options) => {
  const container = ensureContainer();
  if (container.impl?.dispose) {
    try {
      await container.impl.dispose();
    } catch (error) {
      logger2.debug(`[${dir.name}] dispose previous impl failed: ${error?.message || error}`);
    }
  }
  const mcpPath = options?.mcpPath ?? "/MCP";
  container.impl = createMcpImpl({ mcpPath, pluginName: dir.name });
  mountRoutesOnce(container, mcpPath);
};

// src/index.ts
await initMcpPlugin({ mcpPath: getEffectiveMcpPath() });
logger3.info(`${logger3.violet(`[\u63D2\u4EF6:${dir.version}]`)} ${logger3.green(dir.name)} \u521D\u59CB\u5316\u5B8C\u6210~`);
