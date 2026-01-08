export type TestScenarioStep = {
  /** Human readable label for the step. */
  name: string
  /** api -> POST /api/:action, http -> request to mcpUrl + path */
  kind: 'api' | 'http'
  action?: string
  method?: 'GET' | 'POST'
  path?: string
  data?: Record<string, unknown>
  /** Allowed status code(s). Default: 200. */
  expectStatus?: number | number[]
}

export type TestScenario = {
  id: string
  title: string
  description: string
  steps: TestScenarioStep[]
}

const api = (name: string, action: string, data: Record<string, unknown> = {}, expectStatus: number | number[] = 200): TestScenarioStep => ({
  name,
  kind: 'api',
  action,
  data,
  expectStatus,
})

const httpGet = (name: string, path: string, expectStatus: number | number[] = 200): TestScenarioStep => ({
  name,
  kind: 'http',
  method: 'GET',
  path,
  expectStatus,
})

export const TEST_SCENARIOS: TestScenario[] = [
  {
    id: 'core.status',
    title: 'Bot status',
    description: 'Verify the HTTP bridge is alive and MCP server is running.',
    steps: [
      api('status', 'bot.status'),
    ],
  },
  {
    id: 'core.actions',
    title: 'List actions',
    description: 'Discover available HTTP actions via meta.actions.',
    steps: [
      api('actions', 'meta.actions'),
    ],
  },
  {
    id: 'mock.friend.basic',
    title: 'Mock friend message',
    description: 'Inject a DM message and aggregate replies (traceId).',
    steps: [
      api('send', 'mock.incoming.message', {
        message: 'ping',
        user_id: 'mcp-test-user',
        nickname: 'MCP Tester',
        waitMs: 1200,
      }),
    ],
  },
  {
    id: 'mock.group.basic',
    title: 'Mock group message',
    description: 'Inject a group message (role/nickname) and aggregate replies.',
    steps: [
      api('send', 'mock.incoming.message', {
        message: 'hello group',
        user_id: 'mcp-test-user',
        group_id: 'mcp-test-group',
        nickname: 'MCP Tester',
        role: 'member',
        waitMs: 1200,
      }),
    ],
  },
  {
    id: 'mock.rateLimit.user',
    title: 'Rate limit (per user)',
    description: 'Burst multiple requests quickly to exercise 429 responses (depending on limits.*).',
    steps: [
      api('burst#1', 'mock.incoming.message', { message: 'burst 1', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
      api('burst#2', 'mock.incoming.message', { message: 'burst 2', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
      api('burst#3', 'mock.incoming.message', { message: 'burst 3', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
      api('burst#4', 'mock.incoming.message', { message: 'burst 4', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
      api('burst#5', 'mock.incoming.message', { message: 'burst 5', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
      api('burst#6', 'mock.incoming.message', { message: 'burst 6', user_id: 'mcp-burst-user', waitMs: 0 }, [200, 429]),
    ],
  },
  {
    id: 'render.html.and.files',
    title: 'Render screenshot + files endpoint',
    description: 'Render a HTML string into an image, then GET /files/:filename.',
    steps: [
      api('render', 'render.screenshot', {
        file_type: 'htmlString',
        type: 'png',
        return: 'both',
        filename: '{{sessionId}}-render.png',
        file: [
          '<!doctype html>',
          '<html><head><meta charset="utf-8" />',
          '<style>body{margin:0;font-family:system-ui;background:#0b1020;color:#e5e7eb;}',
          '.wrap{display:flex;align-items:center;justify-content:center;height:100vh;}',
          '.card{width:1200px;border-radius:24px;padding:48px;background:linear-gradient(135deg,#111827,#0b1020);',
          'box-shadow:0 30px 80px rgba(0,0,0,.45);}',
          '.title{font-size:48px;font-weight:800;margin:0 0 12px;}',
          '.sub{opacity:.8;font-size:20px;margin:0;}',
          '</style></head><body><div class="wrap"><div class="card">',
          '<p class="sub">karin-plugin-mcp</p>',
          '<h1 class="title">Render Test</h1>',
          '<p class="sub">This is a 1920x1080 template smoke test.</p>',
          '</div></div></body></html>',
        ].join(''),
      }),
      httpGet('files.get', '/files/{{renderFilename}}', [200, 403]),
    ],
  },
  {
    id: 'config.get',
    title: 'Config get (optional)',
    description: 'config.get is optional and depends on mcpTools.configRead.',
    steps: [
      api('config', 'config.get', {}, [200, 403]),
    ],
  },
  {
    id: 'test.records',
    title: 'Test records endpoints',
    description: 'List and tail test records to validate JSONL/trace recording endpoints.',
    steps: [
      api('records.list', 'test.records.list', { limit: 20 }),
      api('records.tail', 'test.records.tail', { limit: 10 }),
    ],
  },
]

export const listTestScenarios = () => {
  return TEST_SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    stepCount: s.steps.length,
  }))
}

export const getTestScenario = (id: string): TestScenario | null => {
  const key = String(id || '').trim()
  if (!key) return null
  return TEST_SCENARIOS.find((s) => s.id === key) ?? null
}

