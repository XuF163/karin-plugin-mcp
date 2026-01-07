import fs from 'node:fs'
import path from 'node:path'

import { createPluginDir, getAllFilesSync } from 'node-karin'

import { dir } from '@/dir'

let ensurePromise: Promise<void> | null = null

/**
 * 初始化 resources 到 Karin 的 `@karinjs/<plugin>/resources`
 * - 只覆盖 template/（方便插件更新帮助模板）
 * - 其他文件仅在缺失时复制，避免覆盖用户自定义内容
 */
export const ensurePluginResources = async () => {
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    const sourceDir = path.join(dir.pluginDir, 'resources')
    const targetDir = dir.defResourcesDir

    if (!fs.existsSync(sourceDir)) return

    await createPluginDir(dir.name, ['resources'])

    const files = getAllFilesSync(sourceDir, { returnType: 'rel' })
    for (const rel of files) {
      const normalizedRel = rel.replaceAll('\\', '/')
      const shouldOverwrite = normalizedRel.startsWith('template/')
      const sourcePath = path.join(sourceDir, rel)
      const targetPath = path.join(targetDir, rel)

      if (fs.existsSync(targetPath) && !shouldOverwrite) continue

      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.copyFileSync(sourcePath, targetPath)
    }
  })().catch((error) => {
    ensurePromise = null
    throw error
  })

  return ensurePromise
}

