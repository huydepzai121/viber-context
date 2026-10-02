import { expect, test } from 'claude-code/testing'

import { INVOICE, KEY, composeInput, ctxArgs, mcpCalls, puts, setup } from './fake-engine'

const WIN = { cwd: 'E:\\Dev\\www\\Proj', top: 'E:/Dev/www/Proj' } as const
const NORM = 'e:\\dev\\www\\proj'
const session = (cwd: string) => ({ cwd, surface: null, isInteractive: false }) as const
const starts = (calls: string[][]) => calls.filter(a => a.join(' ').includes('vibervn-context-engine'))

test('engine not running: started once, then polled until healthy', async ($, on) => {
  const fake = setup(on, { ...WIN, upAfter: 3 })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(10_000)

  expect(starts(fake.starts)).toHaveLength(1)
  expect(fake.starts[0]![0]).toBe('powershell')
  expect(fake.starts[0]!.join(' ')).toContain('vibervn-context-engine --port 6699')
  // Down at the first check, then 1 s polls until it answers; then it registers.
  expect(fake.checks).toBe(4)
  expect(puts(fake)).toHaveLength(1)
})

test('engine that never comes up: status says so and tools fall back', async ($, on) => {
  const fake = setup(on, { ...WIN, upAfter: 9999 })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(30_000)

  expect(fake.statuses.at(-1)).toBe('ctx ✗ engine chưa chạy')
  expect(starts(fake.starts)).toHaveLength(1)
  const ran = await $.tool.call({ tool: 'mcp__viber-context__codebase_retrieval', information_request: 'where is auth' })
  expect(typeof ran.result).toBe('string')
  expect(String(ran.result)).toContain('Grep')
})

test('engine already running: no start command', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  expect(fake.starts).toHaveLength(0)
})

test('unregistered root: PUT appends it and leaves every other field untouched', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: ['d:\\dev\\www\\old'] })
  const before = structuredClone(fake.config)
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  const sent = puts(fake)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toEqual({ ...before, repos: ['d:\\dev\\www\\old', NORM] })
  const body = sent[0]!.body as { purchased_plans: unknown; embedding: { api_keys: unknown } }
  expect(body.purchased_plans).toEqual((before as { purchased_plans: unknown }).purchased_plans)
  expect(body.embedding.api_keys).toEqual(['EMB-FAKE-KEY'])
  // Indexing was requested for the registered root.
  expect(fake.calls.some(c => c.method === 'POST' && c.path.endsWith('/index'))).toBe(true)
})

test('registered root: no PUT', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  expect(puts(fake)).toHaveLength(0)
  expect(fake.calls.some(c => c.method === 'POST' && c.path.endsWith('/index'))).toBe(true)
})

test('the index status line follows the engine from indexing to done', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(10_000)

  expect(fake.statuses.some(s => s.includes('lập chỉ mục 40/120'))).toBe(true)
  expect(fake.statuses.at(-1)).toContain('ctx ● 120 file')
})

for (const [name, cwd] of [['home', 'C:\\Users\\Admin'], ['drive', 'E:\\']] as const) {
  test(`${name} root: no engine, no registration, no index`, async ($, on) => {
    const fake = setup(on, { cwd, top: null, home: 'C:\\Users\\Admin' })
    await $.session.start(session(cwd))
    await fake.clock.advance(30_000)

    expect(fake.calls).toHaveLength(0)
    expect(fake.starts).toHaveLength(0)
    const ran = await $.tool.call({ tool: 'mcp__viber-context__codebase_retrieval', information_request: 'x' })
    expect(String(ran.result)).toContain('Grep')
    expect(fake.calls).toHaveLength(0)
  })
}

test('/ctx off stops auto-index on the next session start', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(10_000)
  expect(fake.calls.length).toBeGreaterThan(0)

  const off = await $.command.run(ctxArgs('off'))
  expect(off.text).toContain('Đã tắt')
  fake.calls.length = 0
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(10_000)
  expect(fake.calls).toHaveLength(0)

  const ran = await $.tool.call({ tool: 'mcp__viber-context__codebase_retrieval', information_request: 'x' })
  expect(String(ran.result)).toContain('/ctx on')
  expect(mcpCalls(fake)).toHaveLength(0)

  await $.command.run(ctxArgs('on'))
  await fake.clock.advance(10_000)
  expect(fake.calls.length).toBeGreaterThan(0)
})

test('the system prompt section is there when enabled and gone when off', async ($, on) => {
  setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  const withIt = await $.prompt.compose(composeInput)
  const section = withIt.sections.find(s => s.id === 'viber-context:retrieval')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('mcp__viber-context__codebase_retrieval')
  expect(withIt.sections.at(-1)?.id).toBe('viber-context:retrieval')

  await $.command.run(ctxArgs('off'))
  const without = await $.prompt.compose(composeInput)
  expect(without.sections.some(s => s.id === 'viber-context:retrieval')).toBe(false)
})

test('codebase_retrieval inlines filters, sends the root and returns a string', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  const ran = await $.tool.call({
    tool: 'mcp__viber-context__codebase_retrieval',
    information_request: 'how are tokens refreshed',
    filter_kind: ['function'],
    filter_lang: ['typescript'],
    filter_path: 'src/api',
  })

  expect(typeof ran.result).toBe('string')
  expect(ran.result).toBe('src/a.ts:1-9 handler')
  const call = mcpCalls(fake)[0]!
  expect(call.path).toBe('/api/mcp-tool')
  expect(call.body).toEqual({
    information_request: 'kind:function lang:typescript path:src/api how are tokens refreshed',
    workspace_full_path: 'E:\\Dev\\www\\Proj',
  })
})

test('file_retrieval posts to its own endpoint with top_k', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  const ran = await $.tool.call({ tool: 'mcp__viber-context__file_retrieval', file_path: 'src/a.ts', information_request: 'the handler', top_k: 3 })

  expect(typeof ran.result).toBe('string')
  expect(mcpCalls(fake)[0]!.path).toBe('/api/mcp-tool/file-retrieval')
  expect(mcpCalls(fake)[0]!.body).toEqual({ file_path: 'src/a.ts', information_request: 'the handler', top_k: 3, workspace_full_path: 'E:\\Dev\\www\\Proj' })
})

test('an engine error becomes a Vietnamese fallback string, not a throw', async ($, on) => {
  const fake = setup(on, { ...WIN, repos: [NORM] })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)
  fake.mcpStatus = 500
  fake.mcpResult = 'boom'

  const ran = await $.tool.call({ tool: 'mcp__viber-context__codebase_retrieval', information_request: 'anything' })

  expect(typeof ran.result).toBe('string')
  expect(String(ran.result)).toContain('Không truy xuất được codebase')
  expect(String(ran.result)).toContain('Grep/Glob/Read')
  expect(String(ran.result)).not.toContain(KEY)
  await fake.clock.settle()
})

test('a posix root starts the engine through sh', async ($, on) => {
  const fake = setup(on, { cwd: '/home/dev/proj', top: '/home/dev/proj', home: '/home/dev', upAfter: 1 })
  await $.session.start(session('/home/dev/proj'))
  await fake.clock.advance(5000)

  expect(fake.starts[0]).toEqual(['sh', '-c', 'nohup vibervn-context-engine --port 6699 >/dev/null 2>&1 &'])
  const put = puts(fake)[0]!.body as { repos: string[] }
  expect(put.repos).toContain('/home/dev/proj')
  expect(INVOICE.length).toBeGreaterThan(0)
})
