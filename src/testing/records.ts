import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dir } from '@/dir'
import { toStr } from '@/mcp/utils'

export type TestHttpRecord = {
  id: string
  time: number
  action: string
  method: string
  ip: string
  status: number
  ok: boolean
  durationMs: number
  traceId?: string
  request: unknown
  responseSummary: unknown
}

export type TestTraceRecord = {
  traceId: string
  time: number
  action: string
  request: unknown
  responses: unknown[]
  durationMs: number
}

export type TestRunRecord = {
  sessionId: string
  time: number
  kind: 'scenario' | 'suite'
  ok: boolean
  durationMs: number
  data: unknown
}

const BASE_DIR = path.join(dir.karinPath, 'data', 'mcp-test')
const HTTP_DIR = path.join(BASE_DIR, 'http')
const TRACE_DIR = path.join(BASE_DIR, 'traces')
const SESSION_DIR = path.join(BASE_DIR, 'sessions')
const RUN_DIR = path.join(BASE_DIR, 'runs')

const ensureDir = (p: string) => {
  fs.mkdirSync(p, { recursive: true })
}

const dateKey = (time: number) => {
  try {
    return new Date(time).toISOString().slice(0, 10)
  } catch {
    return 'unknown-date'
  }
}

const safeId = (value: string, maxLen = 80) => {
  const s = toStr(value).trim().replaceAll(/[^\w-]/g, '')
  return s.slice(0, maxLen) || 'unknown'
}

const truncate = (value: string, maxLen: number) => (value.length > maxLen ? `${value.slice(0, maxLen)}…` : value)

const toSafeValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[depth-limit]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncate(value, 2000)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => toSafeValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toSafeValue(v, depth + 1)
    }
    return obj
  }
  try {
    return truncate(String(value), 500)
  } catch {
    return '[unserializable]'
  }
}

const getHttpLogPath = (time: number) => {
  ensureDir(HTTP_DIR)
  return path.join(HTTP_DIR, `${dateKey(time)}.jsonl`)
}

const getSessionLogPath = (time: number) => {
  ensureDir(SESSION_DIR)
  return path.join(SESSION_DIR, `${dateKey(time)}.jsonl`)
}

export const recordHttp = (record: Omit<TestHttpRecord, 'request' | 'responseSummary'> & { request: unknown, responseSummary: unknown }) => {
  try {
    const line: TestHttpRecord = {
      ...record,
      request: toSafeValue(record.request),
      responseSummary: toSafeValue(record.responseSummary),
    }
    const filePath = getHttpLogPath(record.time)
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, { encoding: 'utf8' })
  } catch {
    // ignore
  }
}

export const recordSession = (record: TestTraceRecord & { traceFile?: string | null }) => {
  try {
    const line = {
      ...record,
      traceFile: record.traceFile ?? null,
      request: toSafeValue(record.request),
      responses: Array.isArray(record.responses) ? record.responses.map((r) => toSafeValue(r)) : [],
    }
    const filePath = getSessionLogPath(record.time)
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, { encoding: 'utf8' })
    return filePath
  } catch {
    return null
  }
}

export const writeTraceRecord = (record: TestTraceRecord) => {
  const safeTraceId = safeId(record.traceId, 120)
  const date = dateKey(record.time)
  const dirPath = path.join(TRACE_DIR, date)
  ensureDir(dirPath)

  const fileName = `trace-${safeTraceId}-${record.time}.json`
  const filePath = path.join(dirPath, fileName)

  const payload: TestTraceRecord = {
    ...record,
    request: toSafeValue(record.request),
    responses: Array.isArray(record.responses) ? record.responses.map((r) => toSafeValue(r)) : [],
  }

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' })
  return filePath
}

export const writeRunRecord = (record: TestRunRecord) => {
  const safeSessionId = safeId(record.sessionId, 120)
  const date = dateKey(record.time)
  const dirPath = path.join(RUN_DIR, date)
  ensureDir(dirPath)

  const fileName = `run-${safeSessionId}-${record.time}.json`
  const filePath = path.join(dirPath, fileName)

  const payload: TestRunRecord = {
    ...record,
    data: toSafeValue(record.data),
  }

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' })
  return filePath
}

const listFiles = (dirPath: string, ext: string): Array<{ file: string, path: string, mtimeMs: number, size: number }> => {
  try {
    if (!fs.existsSync(dirPath)) return []
    return fs.readdirSync(dirPath)
      .filter((name) => name.toLowerCase().endsWith(ext))
      .map((name) => {
        const p = path.join(dirPath, name)
        const st = fs.statSync(p)
        return { file: name, path: p, mtimeMs: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

export const listTestRecords = (options?: { date?: string, limit?: number }) => {
  const limit = Math.min(Math.max(Number(options?.limit || 50), 1), 200)
  const date = toStr(options?.date).trim()

  const http = listFiles(HTTP_DIR, '.jsonl').slice(0, limit)
  const sessions = listFiles(SESSION_DIR, '.jsonl')
    .filter((x) => !date || x.file === `${date}.jsonl`)
    .slice(0, limit)

  const traceBase = TRACE_DIR
  let traces: Array<{ date: string, file: string, path: string, mtimeMs: number, size: number }> = []
  try {
    if (fs.existsSync(traceBase)) {
      const days = date
        ? [date]
        : fs.readdirSync(traceBase).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 30)

      for (const day of days) {
        const dayDir = path.join(traceBase, day)
        const files = listFiles(dayDir, '.json').map((f) => ({ ...f, date: day }))
        traces.push(...files)
      }
    }
  } catch {
    // ignore
  }
  traces = traces.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)

  return {
    baseDir: BASE_DIR,
    http: http.map((x) => ({ file: x.file, mtimeMs: x.mtimeMs, size: x.size })),
    sessions: sessions.map((x) => ({ file: x.file, mtimeMs: x.mtimeMs, size: x.size })),
    traces: traces.map((x) => ({ date: x.date, file: x.file, mtimeMs: x.mtimeMs, size: x.size })),
  }
}

export const tailHttpLog = (options?: { date?: string, limit?: number }) => {
  const limit = Math.min(Math.max(Number(options?.limit || 20), 1), 200)
  const date = toStr(options?.date).trim() || dateKey(Date.now())
  const filePath = path.join(HTTP_DIR, `${date}.jsonl`)
  if (!fs.existsSync(filePath)) return { date, items: [] as any[] }

  const raw = fs.readFileSync(filePath, { encoding: 'utf8' })
  const lines = raw.split('\n').filter(Boolean)
  const tail = lines.slice(-limit)
  const items = tail.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { raw: truncate(line, 500) }
    }
  })

  return { date, items }
}

export const tailSessionLog = (options?: { date?: string, limit?: number, traceId?: string }) => {
  const limit = Math.min(Math.max(Number(options?.limit || 20), 1), 200)
  const date = toStr(options?.date).trim() || dateKey(Date.now())
  const traceId = toStr(options?.traceId).trim()

  const filePath = path.join(SESSION_DIR, `${date}.jsonl`)
  if (!fs.existsSync(filePath)) return { date, items: [] as any[] }

  const raw = fs.readFileSync(filePath, { encoding: 'utf8' })
  const lines = raw.split('\n').filter(Boolean)
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { raw: truncate(line, 500) }
    }
  })

  const filtered = traceId ? parsed.filter((it: any) => toStr(it?.traceId).trim() === traceId) : parsed
  const items = filtered.slice(-limit)
  return { date, items }
}

export const getTraceRecord = (options: { date?: string, file?: string, traceId?: string }) => {
  const date = toStr(options.date).trim()
  const file = toStr(options.file).trim()
  const traceId = toStr(options.traceId).trim()

  const safeFile = file ? path.basename(file) : ''
  if (safeFile && safeFile !== file) return null

  const findByDate = (d: string) => {
    const base = path.join(TRACE_DIR, d)
    if (!fs.existsSync(base)) return null
    if (safeFile) {
      const p = path.join(base, safeFile)
      if (!fs.existsSync(p)) return null
      return p
    }
    if (traceId) {
      const safe = safeId(traceId, 120)
      const files = fs.readdirSync(base).filter((n) => n.startsWith(`trace-${safe}-`) && n.endsWith('.json'))
      if (!files.length) return null
      files.sort().reverse()
      return path.join(base, files[0])
    }
    return null
  }

  const tryDates = date
    ? [date]
    : (() => {
      try {
        if (!fs.existsSync(TRACE_DIR)) return []
        return fs.readdirSync(TRACE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 30)
      } catch {
        return []
      }
    })()

  for (const d of tryDates) {
    const p = findByDate(d)
    if (!p) continue
    try {
      const json = fs.readFileSync(p, { encoding: 'utf8' })
      return { date: d, file: path.basename(p), data: JSON.parse(json) }
    } catch {
      return { date: d, file: path.basename(p), data: null }
    }
  }

  return null
}

export const createSessionId = () => {
  return crypto.randomUUID()
}
