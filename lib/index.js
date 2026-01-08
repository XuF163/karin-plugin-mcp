import {
  initMcpPlugin
} from "./chunk-TW47INNP.js";
import {
  getEffectiveMcpPath
} from "./chunk-BZTWENVK.js";
import {
  dir
} from "./chunk-NF24Q4FD.js";

// src/index.ts
import { logger } from "node-karin";
await initMcpPlugin({ mcpPath: getEffectiveMcpPath() });
logger.info(`${logger.violet(`[\u63D2\u4EF6:${dir.version}]`)} ${logger.green(dir.name)} \u521D\u59CB\u5316\u5B8C\u6210~`);
