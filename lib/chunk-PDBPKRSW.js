import {
  dir
} from "./chunk-NF24Q4FD.js";

// src/mcp/utils.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var toStr = (val) => val === void 0 || val === null ? "" : String(val);
var toNum = (val, fallback) => {
  const num = typeof val === "number" ? val : Number(val);
  return Number.isFinite(num) ? num : fallback;
};
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// src/utils/config.ts
import path from "path";
import { copyConfigSync, requireFileSync } from "node-karin";
var safeRequireJson = (filePath) => {
  try {
    return requireFileSync(filePath);
  } catch {
    return {};
  }
};
var ensurePluginConfig = () => {
  try {
    copyConfigSync(dir.defConfigDir, dir.ConfigDir, [".json"]);
  } catch {
  }
};
var normalizeMcpPath = (value) => {
  const s = toStr(value).trim() || "/MCP";
  return s.startsWith("/") ? s : `/${s}`;
};
var getMcpPluginConfig = () => {
  ensurePluginConfig();
  const def = safeRequireJson(path.join(dir.defConfigDir, "config.json"));
  const cfg = safeRequireJson(path.join(dir.ConfigDir, "config.json"));
  const merged = {
    mcpPath: "/MCP",
    apiKey: "",
    ...def,
    ...cfg
  };
  return {
    mcpPath: normalizeMcpPath(merged.mcpPath),
    apiKey: toStr(merged.apiKey).trim()
  };
};
var getEffectiveMcpPath = () => getMcpPluginConfig().mcpPath;
var getEffectiveApiKey = () => {
  const envKey = toStr(process.env.KARIN_MCP_API_KEY || process.env.HTTP_AUTH_KEY || "").trim();
  if (envKey) return envKey;
  return getMcpPluginConfig().apiKey;
};

// src/mcp/baseUrl.ts
var getLocalBaseUrl = () => {
  const port = toStr(process.env.HTTP_PORT || "7777").trim() || "7777";
  return `http://127.0.0.1:${port}`;
};

export {
  sleep,
  toStr,
  toNum,
  clamp,
  getEffectiveMcpPath,
  getEffectiveApiKey,
  getLocalBaseUrl
};
