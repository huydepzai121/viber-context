import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// A fake vibervn-context-engine behind the host's http.fetch and process.run,
// plus the session facts a hook reads. No real network or process.

export const KEY = 'pk_FAKE_SECRET_KEY_0123456789'
export const INVOICE = 'INV-FAKE-123456'
export const BASE = 'https://billing.example/v1'
export const NOW = Date.parse('2026-10-03T00:00:00Z')
const DAY = 86_400_000

export type Call = { method: string; path: string; body: unknown; auth: string | undefined }

export type Fake = {
  // Health answers only from the n-th check on (0: running from the start).
  upAfter: number
  checks: number
  config: Record<string, unknown>
  usage: { status: number; body: unknown }
  mcpStatus: number
  mcpResult: unknown
  calls: Call[]
  starts: string[][]
  statuses: string[]
  toasts: string[]
  clock: ReturnType<typeof mock.clock>
}

export function fakeConfig(repos: readonly string[], expiresAt = NOW + 15 * DAY): Record<string, unknown> {
  return {
    version: 13,
    repos: [...repos],
    embedding: { provider: 'voyage', model: 'voyage-4-lite', api_keys: ['EMB-FAKE-KEY'], voyage_base_url: BASE, dimensions: 1024 },
    llm: { api_keys: ['LLM-FAKE-KEY'] },
    mcp_index_wait_secs: 30,
    repo_generations: { 'e:\\dev\\www\\other': 3 },
    machine_id: 'machine-fake',
    purchased_plans: [{
      invoice: INVOICE, proxy_key: KEY, base_url: BASE, package_name: '5 Beer', purchased_at: 1, expires_at: expiresAt, is_free_trial: false,
    }],
  }
}

export type Setup = {
  cwd: string
  // What `git rev-parse --show-toplevel` answers; null when the cwd is no repo.
  top: string | null
  repos?: readonly string[]
  upAfter?: number
  home?: string
  searchLeft?: number
  expiresAt?: number
}

export function setup(on: On, s: Setup): Fake {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USERPROFILE: s.home ?? 'C:\\Users\\Admin' })
  const fake: Fake = {
    upAfter: s.upAfter ?? 0,
    checks: 0,
    config: fakeConfig(s.repos ?? [], s.expiresAt),
    usage: { status: 200, body: { expires_at: '2026-10-18', openai_budget: 10000, openai_remaining: s.searchLeft ?? 9992, voyage_budget: 1000000, voyage_remaining: 997081 } },
    mcpStatus: 200,
    mcpResult: { result: 'src/a.ts:1-9 handler' },
    calls: [],
    starts: [],
    statuses: [],
    toasts: [],
    clock,
  }
  let indexed = false
  let polls = 0

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: s.cwd }))
  on('ui.status', (_$, e) => {
    if (e.text !== undefined) fake.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    fake.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('process.run', (_$, e) => {
    const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git') return s.top === null ? out(128, '') : out(0, `${s.top}\n`)
    fake.starts.push([...e.argv])
    return out(0, '')
  })
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    const body: unknown = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    const auth = e.init?.headers?.authorization
    const reply = (status: number, payload: unknown) => ({
      value: { status, ok: status >= 200 && status < 300, headers: {}, text: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    })
    fake.calls.push({ method, path: url.pathname, body, auth })
    const isUp = () => fake.upAfter === 0 || (fake.starts.length > 0 && fake.checks > fake.upAfter)
    if (url.pathname === '/api/repos' && method === 'GET') {
      fake.checks += 1
      // The engine only comes up once a start command was issued (or from the start).
      if (!isUp()) throw new Error('ECONNREFUSED')
      return reply(200, { repos: [] })
    }
    if (!isUp()) throw new Error('ECONNREFUSED')
    if (url.pathname === '/api/config' && method === 'GET') return reply(200, fake.config)
    if (url.pathname === '/api/config' && method === 'PUT') {
      fake.config = body as Record<string, unknown>
      return reply(200, fake.config)
    }
    if (url.pathname === '/api/plan/usage') {
      return auth === `Bearer ${KEY}` ? reply(fake.usage.status, fake.usage.body) : reply(401, { error: 'unauthorized' })
    }
    if (url.pathname.endsWith('/index') && method === 'POST') {
      indexed = true
      return reply(202, { status: 'accepted' })
    }
    if (url.pathname.endsWith('/status')) {
      if (!indexed) return reply(200, { state: 'idle', indexed_files: 0, total_files: 0, last_indexed_at: null })
      polls += 1
      return polls < 2
        ? reply(200, { state: 'indexing', indexed_files: 40, total_files: 120, last_indexed_at: null })
        : reply(200, { state: 'idle', indexed_files: 120, total_files: 120, last_indexed_at: '2026-10-03T00:01:00Z' })
    }
    if (url.pathname.startsWith('/api/mcp-tool')) return reply(fake.mcpStatus, fake.mcpResult)
    return reply(404, {})
  })
  return fake
}

export const START = { cwd: '', surface: null, isInteractive: false } as const
export const mcpCalls = (f: Fake): Call[] => f.calls.filter(c => c.path.startsWith('/api/mcp-tool'))
export const puts = (f: Fake): Call[] => f.calls.filter(c => c.method === 'PUT')

// A /ctx run as the engine hands it to the command hook.
export const ctxArgs = (args: string) => ({
  command: 'ctx',
  args,
  origin: { kind: 'plugin', name: 'test' },
  presentation: { isFullscreen: false, columns: 80 },
}) as const

export const composeInput = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as const
