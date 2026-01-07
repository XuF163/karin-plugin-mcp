import {
  getEffectiveApiKey,
  getEffectiveMcpPath,
  getLocalBaseUrl,
  toStr
} from "../chunk-PDBPKRSW.js";
import {
  dir
} from "../chunk-NF24Q4FD.js";

// src/apps/help.ts
import path2 from "path";
import { karin, logger, render, segment } from "node-karin";

// src/utils/resources.ts
import fs from "fs";
import path from "path";
import { createPluginDir, getAllFilesSync } from "node-karin";
var ensurePromise = null;
var ensurePluginResources = async () => {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const sourceDir = path.join(dir.pluginDir, "resources");
    const targetDir = dir.defResourcesDir;
    if (!fs.existsSync(sourceDir)) return;
    await createPluginDir(dir.name, ["resources"]);
    const files = getAllFilesSync(sourceDir, { returnType: "rel" });
    for (const rel of files) {
      const normalizedRel = rel.replaceAll("\\", "/");
      const shouldOverwrite = normalizedRel.startsWith("template/");
      const sourcePath = path.join(sourceDir, rel);
      const targetPath = path.join(targetDir, rel);
      if (fs.existsSync(targetPath) && !shouldOverwrite) continue;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
};

// src/apps/help.ts
var formatDateTime = (date) => {
  try {
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  } catch {
    return date.toISOString();
  }
};
var maskSecret = (value) => {
  const s = toStr(value).trim();
  if (!s) return "";
  if (s.length <= 4) return "*".repeat(s.length);
  if (s.length <= 8) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
};
var buildTextHelp = (options) => {
  const apiKeyMasked = options.apiKey ? maskSecret(options.apiKey) : "";
  return [
    `\u3010${dir.name} v${dir.version}\u3011`,
    "\u7528\u9014\uFF1A\u8BA9 LLM/IDE \u901A\u8FC7 MCP(stdio) \u8C03\u7528 Karin\uFF08mcp-server \u2192 HTTP Bridge \u2192 Bot Adapter\uFF09",
    "",
    "\u6307\u4EE4\uFF1A",
    "- #mcp \u5E2E\u52A9\uFF1A\u67E5\u770B\u672C\u5E2E\u52A9",
    "",
    "HTTP Bridge\uFF1A",
    `- \u5730\u5740\uFF1A${options.mcpUrl}`,
    `- \u5065\u5EB7\u68C0\u67E5\uFF1AGET ${options.mcpUrl}/health`,
    `- \u6E32\u67D3\u4EA7\u7269\uFF1AGET ${options.mcpUrl}/files/:filename`,
    `- Actions\uFF1APOST ${options.mcpUrl}/api/bot.status | mock.incoming.message | mock.status | mock.history | render.screenshot`,
    "",
    "\u9274\u6743\uFF1A",
    `- \u5F53\u524D\uFF1A${options.apiKey ? `\u5DF2\u542F\u7528\uFF08${apiKeyMasked}\uFF09` : "\u672A\u542F\u7528\uFF08\u65E0\u9700\u9274\u6743\uFF09"}`,
    `- \u914D\u7F6E\u6587\u4EF6\uFF1A${options.configPath}\uFF08mcpPath/apiKey\uFF09`,
    "- \u8BBE\u7F6E\u4F18\u5148\u7EA7\uFF1A\u73AF\u5883\u53D8\u91CF KARIN_MCP_API_KEY\uFF08\u4F18\u5148\uFF09\u6216 HTTP_AUTH_KEY > \u914D\u7F6E\u6587\u4EF6 apiKey",
    "- \u4F20\u9012\uFF1AX-API-Key / Authorization: Bearer <key> / ?apiKey=<key> / body.apiKey",
    "",
    "MCP Server\uFF08\u7ED9 IDE/\u5BA2\u6237\u7AEF\u914D\u7F6E\uFF09\uFF1A",
    `- \u542F\u52A8\u6587\u4EF6\uFF1A${options.mcpServerPath}`,
    `- \u63A8\u8350 env\uFF1AKARIN_MCP_URL=${options.mcpUrl}`,
    "- \u6216\uFF1AKARIN_BASE_URL + KARIN_MCP_PATH\uFF1B\u53EF\u9009 KARIN_MCP_API_KEY",
    "",
    "\u66F4\u591A\u8BF4\u660E\uFF1Adocs/API.md"
  ].join("\n");
};
var mcpHelp = karin.command(/^#?mcp(?:\s*(?:帮助|help))?$/i, async (e) => {
  const baseUrl = getLocalBaseUrl();
  const mcpPath = getEffectiveMcpPath();
  const mcpUrl = `${baseUrl}${mcpPath}`;
  const apiKey = getEffectiveApiKey();
  const apiKeyStatus = apiKey ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528\uFF08\u65E0\u9700\u9274\u6743\uFF09";
  const apiKeyMasked = apiKey ? maskSecret(apiKey) : "-";
  const configPath = path2.join(dir.ConfigDir, "config.json");
  const mcpServerPath = path2.join(dir.pluginDir, "lib", "mcp-server.js");
  try {
    await ensurePluginResources();
    const html = path2.join(dir.defResourcesDir, "template", "mcp-help.html");
    const img = await render.render({
      name: "mcp-help",
      encoding: "base64",
      file: html,
      type: "png",
      data: {
        name: dir.name,
        version: dir.version,
        generatedAt: formatDateTime(/* @__PURE__ */ new Date()),
        mcpUrl,
        apiKeyStatus,
        apiKeyMasked,
        configPath,
        mcpServerPath
      },
      setViewport: {
        width: 900,
        height: 860,
        deviceScaleFactor: 2
      },
      pageGotoParams: {
        waitUntil: "networkidle2"
      }
    });
    await e.reply(segment.image(`base64://${img}`));
    return true;
  } catch (error) {
    logger.error(error);
    await e.reply(buildTextHelp({ mcpUrl, apiKey, configPath, mcpServerPath }));
    return true;
  }
}, {
  priority: 9999,
  log: true,
  name: "MCP\u5E2E\u52A9",
  permission: "all"
});
export {
  mcpHelp
};
