import {
  ensurePluginResources
} from "../chunk-4WXNFUYP.js";
import {
  getEffectiveMcpPath,
  getLocalBaseUrl,
  getMcpPluginConfig,
  toStr
} from "../chunk-BZTWENVK.js";
import {
  dir
} from "../chunk-NF24Q4FD.js";

// src/apps/help.ts
import path from "path";
import { karin, logger, render, segment } from "node-karin";
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
var getEventUserId = (e) => {
  return toStr(e?.userId || e?.user_id || e?.sender?.userId || e?.sender?.user_id || e?.sender?.id || e?.user?.id).trim();
};
var getEventGroupId = (e) => {
  return toStr(e?.groupId || e?.group_id || e?.group?.id || e?.group?.group_id || e?.contact?.id || e?.contact?.groupId || e?.contact?.group_id).trim();
};
var hasViewPermission = (e) => {
  const cfg = getMcpPluginConfig();
  const level = cfg.command.view;
  const isMaster = Boolean(e?.isMaster);
  const isAdmin = Boolean(e?.isAdmin);
  if (level === "all") return true;
  if (isMaster) return true;
  if (level === "master") return false;
  if (level === "admin") return isAdmin;
  if (isAdmin) return true;
  const userId = getEventUserId(e);
  const groupId = getEventGroupId(e);
  if (userId && cfg.command.allowUserIds.includes(userId)) return true;
  if (groupId && cfg.command.allowGroupIds.includes(groupId)) return true;
  return false;
};
var buildTextHelp = (options) => {
  return [
    `\u3010${dir.name} v${dir.version}\u3011`,
    "\u7528\u9014\uFF1A\u8BA9 LLM/IDE \u901A\u8FC7 MCP(stdio) \u8C03\u7528 Karin\uFF08mcp-server -> HTTP Bridge -> Bot Adapter\uFF09\u3002",
    "",
    "\u547D\u4EE4\uFF08\u53EA\u8BFB\uFF09\uFF1A",
    "- #mcp \u5E2E\u52A9",
    "- #mcp \u914D\u7F6E\uFF08\u4FEE\u6539\u914D\u7F6E\u8BF7\u524D\u5F80 Web UI\uFF09",
    "- #mcp \u72B6\u6001",
    "- #mcp \u5BFC\u51FA\u914D\u7F6E\uFF08\u8FD4\u56DE MCP Host \u914D\u7F6E JSON\uFF09",
    "",
    "HTTP Bridge\uFF1A",
    `- \u5730\u5740\uFF1A${options.mcpUrl}`,
    `- \u5065\u5EB7\u68C0\u67E5\uFF1AGET ${options.mcpUrl}/health`,
    `- \u6E32\u67D3\u4EA7\u7269\uFF1AGET ${options.mcpUrl}/files/:filename`,
    `- Actions\uFF1APOST ${options.mcpUrl}/api/bot.status | mock.incoming.message | mock.status | mock.history | render.screenshot | meta.actions | config.get\uFF08\u9700\u5F00\u542F\uFF09 | test.scenarios.list | test.scenario.run | test.scenarios.runAll | test.records.list | test.records.tail | test.trace.get`,
    "",
    "\u5B89\u5168\uFF1A",
    "- \u9ED8\u8BA4\u65E0 Key \u9274\u6743\uFF08\u4EC5\u5EFA\u8BAE\u672C\u673A/\u5185\u7F51\u4F7F\u7528\uFF09\u3002",
    "- \u5982\u9700\u9650\u5236\u8BBF\u95EE\uFF0C\u8BF7\u5728 Web UI \u914D\u7F6E security.ipAllowlist\uFF08IP/CIDR \u767D\u540D\u5355\uFF09\u3002",
    `- \u914D\u7F6E\u6587\u4EF6\uFF1A${options.configPath}`,
    "",
    "MCP Server\uFF08\u7ED9 IDE/MCP Host \u914D\u7F6E\uFF09\uFF1A",
    `- \u542F\u52A8\u6587\u4EF6\uFF1A${options.mcpServerPath}`,
    `- \u63A8\u8350 args\uFF1A--karin-url ${options.mcpUrl} --log-level error`,
    "",
    "\u66F4\u591A\u8BF4\u660E\uFF1Adocs/API.md"
  ].join("\n");
};
var mcpHelp = karin.command(/^#?mcp(?:\s*(?:帮助|help))?$/i, async (e) => {
  const baseUrl = getLocalBaseUrl();
  const mcpPath = getEffectiveMcpPath();
  const mcpUrl = `${baseUrl}${mcpPath}`;
  const configPath = path.join(dir.ConfigDir, "config.json");
  const mcpServerPath = path.join(dir.pluginDir, "lib", "mcp-server.js");
  try {
    if (!hasViewPermission(e)) {
      await e.reply("\u6743\u9650\u4E0D\u8DB3\uFF1A\u8BF7\u5728 Web UI \u914D\u7F6E command.view / allowlist \u540E\u91CD\u8BD5\u3002");
      return true;
    }
    await ensurePluginResources();
    const html = path.join(dir.defResourcesDir, "template", "mcp-help.html");
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
        authText: "No Key (IP allowlist optional)",
        configPath,
        mcpServerPath
      },
      setViewport: {
        width: 1920,
        height: 1080,
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
    await e.reply(buildTextHelp({ mcpUrl, configPath, mcpServerPath }));
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
