import type { Request } from 'express'

const GLOBAL_KEY = '__KARIN_PLUGIN_MCP_REGISTRY__'

export type McpActionHandler = (ctx: { req: Request, data: any }) => Promise<any> | any

export type McpActionSpec = {
  /** HTTP action name (e.g. "my.action"). */
  name: string
  description: string
  /** Required scopes (OR). Default: ["ext"]. */
  scopes?: string[]
  /** Minimal JSON schema (object/required/properties/enum) for best-effort validation. */
  inputSchema?: Record<string, unknown>
  handler: McpActionHandler
}

type Registry = {
  actions: Map<string, McpActionSpec>
}

const getRegistry = (): Registry => {
  const globalAny = globalThis as any
  if (!globalAny[GLOBAL_KEY]) {
    globalAny[GLOBAL_KEY] = { actions: new Map<string, McpActionSpec>() } satisfies Registry
  }
  return globalAny[GLOBAL_KEY] as Registry
}

export const registerMcpAction = (spec: McpActionSpec) => {
  const name = String(spec?.name || '').trim()
  if (!name) throw new Error('registerMcpAction: name required')
  if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new Error(`registerMcpAction: invalid name: ${name}`)

  const reg = getRegistry()
  if (reg.actions.has(name)) throw new Error(`registerMcpAction: duplicate action: ${name}`)
  reg.actions.set(name, { ...spec, name })
}

export const getMcpAction = (name: string): McpActionSpec | null => {
  const n = String(name || '').trim()
  if (!n) return null
  return getRegistry().actions.get(n) ?? null
}

export const listMcpActions = (): McpActionSpec[] => Array.from(getRegistry().actions.values())

export const validateInputSchema = (schema: any, data: any): { ok: true } | { ok: false, error: string } => {
  if (!schema || typeof schema !== 'object') return { ok: true }

  const type = String(schema.type || '').toLowerCase()
  if (type && type !== 'object') return { ok: true }

  if (!data || typeof data !== 'object') return { ok: false, error: 'data must be an object' }

  const required: string[] = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (!(key in data)) return { ok: false, error: `missing required field: ${key}` }
  }

  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {}
  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in data)) continue
    if (!propSchema || typeof propSchema !== 'object') continue

    const val = (data as any)[key]
    const t = String((propSchema as any).type || '').toLowerCase()

    if (t === 'string' && typeof val !== 'string') return { ok: false, error: `${key} must be string` }
    if (t === 'number' && typeof val !== 'number') return { ok: false, error: `${key} must be number` }
    if (t === 'boolean' && typeof val !== 'boolean') return { ok: false, error: `${key} must be boolean` }
    if (t === 'object' && (typeof val !== 'object' || val === null || Array.isArray(val))) return { ok: false, error: `${key} must be object` }

    const en = (propSchema as any).enum
    if (Array.isArray(en) && !en.includes(val)) return { ok: false, error: `${key} must be one of: ${en.join(', ')}` }
  }

  return { ok: true }
}

