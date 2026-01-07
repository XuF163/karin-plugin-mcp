import { logger } from 'node-karin'

import { dir } from './dir'
import { initMcpPlugin } from './mcp/init'
import { getEffectiveMcpPath } from './utils/config'

await initMcpPlugin({ mcpPath: getEffectiveMcpPath() })

logger.info(`${logger.violet(`[插件:${dir.version}]`)} ${logger.green(dir.name)} 初始化完成~`)
