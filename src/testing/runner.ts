import path from 'node:path'
import crypto from 'node:crypto'

import { toStr } from '@/mcp/utils'

import type { TestScenario, TestScenarioStep } from './scenarios'
import { createSessionId, writeRunRecord } from './records'

export type ScenarioStepResult = {
  name: string
  kind: 'api' | 'http'
  target: string
  expectedStatus: number[]
  status: number
  ok: boolean
  durationMs: number
  traceId?: string
  traceFile?: { date: string, file: string } | null
  responseSummary?: unknown
  error?: string
}

export type ScenarioRunResult = {
  sessionId: string
  scenarioId: string
  title: string
  ok: boolean
  startedAt: number
  finishedAt: number
  durationMs: number
  steps: ScenarioStepResult[]
  runFile: { date: string, file: string } | null
}

export type ScenarioSuiteRunResult = {
  sessionId: string
  ok: boolean
  startedAt: number
  finishedAt: number
  durationMs: number
  scenarios: Array<Pick<ScenarioRunResult, 'scenarioId' | 'title' | 'ok' | 'durationMs' | 'runFile'>>
  runFile: { date: string, file: string } | null
}

const normalizeExpected = (expectStatus: number | number[] | undefined): number[] => {
  if (Array.isArray(expectStatus) && expectStatus.length) return expectStatus.map((n) => Number(n)).filter((n) => Number.isInteger(n))
  if (Number.isInteger(expectStatus as any)) return [Number(expectStatus)]
  return [200]
}

const matchesExpected = (status: number, expected: number[]) => expected.includes(status)

const applyTemplate = (value: unknown, vars: Record<string, string>): unknown => {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (_m, key) => (key in vars ? vars[key] : ''))
  }
  if (Array.isArray(value)) return value.map((v) => applyTemplate(v, vars))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = applyTemplate(v, vars)
    return out
  }
  return value
}

const summarizeApiResponse = (action: string, json: any): unknown => {
  if (!json || typeof json !== 'object') return json
  if (json.success === false) return { success: false, error: toStr(json.error || '').trim() || undefined }

  const d = json.data ?? null
  if (action === 'mock.incoming.message') {
    const responses = Array.isArray(d?.responses) ? d.responses : []
    const replies = responses
      .map((r: any) => toStr(r?.msg || '').trim())
      .filter(Boolean)
      .slice(0, 8)
    return { traceId: d?.traceId ?? null, replyCount: responses.length, replies }
  }
  if (action === 'render.screenshot') {
    const results = Array.isArray(d?.results) ? d.results : []
    return {
      type: d?.type ?? null,
      count: results.length,
      results: results.slice(0, 5).map((r: any) => ({ filename: r?.filename ?? null, url: r?.url ?? null })),
    }
  }
  if (action === 'bot.status') {
    return {
      mcpPath: d?.mcpPath ?? null,
      mcpServer: d?.mcpServer ?? null,
      adapter: d?.adapter ?? null,
      buffers: d?.buffers ?? null,
    }
  }
  if (action === 'meta.actions') {
    const actions = Array.isArray(d?.actions) ? d.actions : []
    return { count: actions.length, actions: actions.slice(0, 20).map((a: any) => toStr(a?.name || '').trim()).filter(Boolean) }
  }

  return d
}

const captureVars = (action: string, json: any, vars: Record<string, string>) => {
  if (!json || typeof json !== 'object') return
  const d = json.data ?? null

  if (action === 'mock.incoming.message') {
    const traceId = toStr(d?.traceId).trim()
    if (traceId) vars.lastTraceId = traceId
  }

  if (action === 'render.screenshot') {
    const results = Array.isArray(d?.results) ? d.results : []
    const filename = toStr(results?.[0]?.filename).trim()
    if (filename) vars.renderFilename = filename
  }
}

const buildApiUrl = (mcpUrl: string, action: string) => `${mcpUrl}/api/${action}`

const safeJson = async (res: Response) => {
  try {
    return await res.json()
  } catch {
    const text = await res.text().catch(() => '')
    return text ? { raw: text.slice(0, 2000) } : null
  }
}

const ensureDefaultTraceId = (sessionId: string, scenarioId: string, stepIndex: number) => {
  const s = scenarioId.replaceAll(/[^\w-]/g, '-')
  return `${sessionId}-${s}-${stepIndex}-${crypto.randomUUID().slice(0, 8)}`
}

const ensureDefaultFilename = (sessionId: string, scenarioId: string, stepIndex: number) => {
  const s = scenarioId.replaceAll(/[^\w-]/g, '-')
  return `${sessionId}-${s}-${stepIndex}.png`
}

const runStep = async (mcpUrl: string, scenarioId: string, sessionId: string, step: TestScenarioStep, stepIndex: number, defaults: Record<string, unknown>, vars: Record<string, string>): Promise<ScenarioStepResult> => {
  const startedAt = Date.now()
  const expectedStatus = normalizeExpected(step.expectStatus)

  try {
    if (step.kind === 'api') {
      const action = toStr(step.action).trim()
      if (!action) throw new Error('scenario step action required')

      const rawData: Record<string, unknown> = {
        ...defaults,
        ...(step.data || {}),
      }

      // Presets to make traces/artifacts easier to locate.
      if (action === 'mock.incoming.message' && !rawData.traceId) {
        rawData.traceId = ensureDefaultTraceId(sessionId, scenarioId, stepIndex)
      }
      if (action === 'render.screenshot' && !rawData.filename) {
        rawData.filename = ensureDefaultFilename(sessionId, scenarioId, stepIndex)
      }

      const data = applyTemplate(rawData, vars) as any
      const url = buildApiUrl(mcpUrl, action)

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const json = await safeJson(res)

      captureVars(action, json, vars)
      const ok = matchesExpected(res.status, expectedStatus)

      return {
        name: step.name,
        kind: step.kind,
        target: action,
        expectedStatus,
        status: res.status,
        ok,
        durationMs: Date.now() - startedAt,
        traceId: toStr(json?.data?.traceId).trim() || undefined,
        traceFile: json?.data?.traceFile || null,
        responseSummary: summarizeApiResponse(action, json),
      }
    }

    const method = (step.method || 'GET').toUpperCase() as any
    const rawPath = toStr(step.path).trim()
    if (!rawPath) throw new Error('scenario step path required')

    const pathWithVars = String(applyTemplate(rawPath, vars) || '').trim()
    const url = pathWithVars.startsWith('http://') || pathWithVars.startsWith('https://') ? pathWithVars : `${mcpUrl}${pathWithVars.startsWith('/') ? '' : '/'}${pathWithVars}`

    const res = await fetch(url, { method })
    const ok = matchesExpected(res.status, expectedStatus)

    return {
      name: step.name,
      kind: step.kind,
      target: url,
      expectedStatus,
      status: res.status,
      ok,
      durationMs: Date.now() - startedAt,
      responseSummary: { contentType: res.headers.get('content-type') || null },
    }
  } catch (error: any) {
    return {
      name: step.name,
      kind: step.kind,
      target: step.kind === 'api' ? toStr(step.action).trim() : toStr(step.path).trim(),
      expectedStatus,
      status: 0,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error),
    }
  }
}

export const runTestScenario = async (options: {
  mcpUrl: string
  scenario: TestScenario
  sessionId?: string
  defaults?: Record<string, unknown>
}): Promise<ScenarioRunResult> => {
  const sessionId = options.sessionId || createSessionId()
  const startedAt = Date.now()
  const vars: Record<string, string> = { sessionId }

  const defaults: Record<string, unknown> = {
    user_id: 'mcp-test-user',
    nickname: 'MCP Tester',
    role: 'member',
    waitMs: 1200,
    ...(options.defaults || {}),
  }

  const steps: ScenarioStepResult[] = []
  for (let i = 0; i < options.scenario.steps.length; i++) {
    const step = options.scenario.steps[i]
    const result = await runStep(options.mcpUrl, options.scenario.id, sessionId, step, i + 1, defaults, vars)
    steps.push(result)
  }

  const finishedAt = Date.now()
  const ok = steps.every((s) => s.ok)

  const runPayload = {
    sessionId,
    scenario: { id: options.scenario.id, title: options.scenario.title },
    ok,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    steps,
  }

  let runFile: { date: string, file: string } | null = null
  try {
    const filePath = writeRunRecord({
      sessionId,
      time: startedAt,
      kind: 'scenario',
      ok,
      durationMs: finishedAt - startedAt,
      data: runPayload,
    })
    runFile = { date: new Date(startedAt).toISOString().slice(0, 10), file: path.basename(filePath) }
  } catch {
    // ignore
  }

  return {
    sessionId,
    scenarioId: options.scenario.id,
    title: options.scenario.title,
    ok,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    steps,
    runFile,
  }
}

export const runTestScenarioSuite = async (options: {
  mcpUrl: string
  scenarios: TestScenario[]
  sessionId?: string
  defaults?: Record<string, unknown>
}): Promise<ScenarioSuiteRunResult> => {
  const sessionId = options.sessionId || createSessionId()
  const startedAt = Date.now()

  const scenarios: ScenarioSuiteRunResult['scenarios'] = []
  for (const scenario of options.scenarios) {
    const result = await runTestScenario({ mcpUrl: options.mcpUrl, scenario, sessionId, defaults: options.defaults })
    scenarios.push({
      scenarioId: result.scenarioId,
      title: result.title,
      ok: result.ok,
      durationMs: result.durationMs,
      runFile: result.runFile,
    })
  }

  const finishedAt = Date.now()
  const ok = scenarios.every((s) => s.ok)

  const suitePayload = {
    sessionId,
    ok,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    scenarios,
  }

  let runFile: { date: string, file: string } | null = null
  try {
    const filePath = writeRunRecord({
      sessionId,
      time: startedAt,
      kind: 'suite',
      ok,
      durationMs: finishedAt - startedAt,
      data: suitePayload,
    })
    runFile = { date: new Date(startedAt).toISOString().slice(0, 10), file: path.basename(filePath) }
  } catch {
    // ignore
  }

  return {
    sessionId,
    ok,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    scenarios,
    runFile,
  }
}

