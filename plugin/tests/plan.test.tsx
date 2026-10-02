import { expect, test } from 'claude-code/testing'

import { INVOICE, KEY, NOW, composeInput, ctxArgs, mcpCalls, setup } from './fake-engine'
import { bar, planLevel } from '../hooks/lib'

const WIN = { cwd: 'E:\\Dev\\www\\Proj', top: 'E:/Dev/www/Proj', repos: ['e:\\dev\\www\\proj'] } as const
const session = { cwd: WIN.cwd, surface: null, isInteractive: false } as const
const RETRIEVAL = 'mcp__viber-context__codebase_retrieval'
const DAY = 86_400_000

test('a healthy plan shows searches and days beside the index', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses.at(-1)).toBe('ctx ● 120 file · còn 9.992 search · 15 ngày')
  expect(fake.toasts).toHaveLength(0)
  // The usage call carried the plan's key; the key is not in any status line.
  expect(fake.calls.find(c => c.path === '/api/plan/usage')?.auth).toBe(`Bearer ${KEY}`)
  expect(fake.statuses.some(s => s.includes(KEY))).toBe(false)
})

test('few searches left: warning prefix, one toast per session', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 8 })
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses.at(-1)).toBe('⚠ ctx ● 120 file · còn 8 search · 15 ngày')
  expect(fake.toasts).toHaveLength(1)
  // The ten-minute refresh and a retrieval refresh do not toast again.
  await fake.clock.advance(11 * 60_000)
  await $.tool.call({ tool: RETRIEVAL, information_request: 'x' })
  await fake.clock.settle()
  expect(fake.toasts).toHaveLength(1)
})

test('warning thresholds: 5% of the limit, 50 searches, 3 days', () => {
  const plan = (searchLeft: number, expiresAt = NOW + 30 * DAY) => ({ known: true, expiresAt, searchLeft, searchLimit: 10_000 })
  expect(planLevel(plan(501), NOW)).toBe('ok')
  expect(planLevel(plan(500), NOW)).toBe('warn')
  expect(planLevel(plan(10_000, NOW + 3 * DAY), NOW)).toBe('warn')
  expect(planLevel(plan(10_000, NOW + 4 * DAY), NOW)).toBe('ok')
  expect(planLevel({ known: true, expiresAt: NOW + 30 * DAY, searchLeft: 50, searchLimit: 100_000 }, NOW)).toBe('warn')
  expect(planLevel(plan(0), NOW)).toBe('out')
  expect(planLevel(plan(5, NOW - 1), NOW)).toBe('expired')
  expect(bar(997_081, 1_000_000)).toHaveLength(20)
})

test('no searches left: tools answer without calling the engine, prompt says unavailable', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 0 })
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses.at(-1)).toBe('ctx ✗ hết lượt search')
  const ran = await $.tool.call({ tool: RETRIEVAL, information_request: 'where is auth' })
  expect(typeof ran.result).toBe('string')
  expect(String(ran.result)).toContain('hết lượt search')
  expect(String(ran.result)).toContain('Grep')
  const file = await $.tool.call({ tool: 'mcp__viber-context__file_retrieval', file_path: 'a.ts', information_request: 'x' })
  expect(String(file.result)).toContain('hết lượt search')
  expect(mcpCalls(fake)).toHaveLength(0)

  const sections = (await $.prompt.compose(composeInput)).sections
  expect(sections.at(-1)?.text).toContain('unavailable')
  expect(sections.at(-1)?.text).not.toContain('call `mcp__viber-context__codebase_retrieval` first')
  expect(fake.toasts).toHaveLength(1)
})

test('expired plan: same short-circuit', async ($, on) => {
  const fake = setup(on, { ...WIN, expiresAt: NOW - DAY })
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses.at(-1)).toBe('ctx ✗ gói đã hết hạn')
  const ran = await $.tool.call({ tool: RETRIEVAL, information_request: 'x' })
  expect(String(ran.result)).toContain('hết hạn')
  expect(mcpCalls(fake)).toHaveLength(0)
})

test('usage 401: nothing breaks, the status shows the index only', async ($, on) => {
  const fake = setup(on, WIN)
  fake.usage = { status: 401, body: { error: 'unauthorized' } }
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses.at(-1)).toBe('ctx ● 120 file')
  const ran = await $.tool.call({ tool: RETRIEVAL, information_request: 'x' })
  expect(ran.result).toBe('src/a.ts:1-9 handler')
  const ctx = await $.command.run(ctxArgs(''))
  expect(ctx.text).toContain('không đọc được mức sử dụng')
})

test('/ctx shows the plan block with both bars and never a key or invoice', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session)
  await fake.clock.advance(10_000)

  for (const args of ['', 'goi']) {
    const out = String((await $.command.run(ctxArgs(args))).text)
    expect(out).toContain('Gói dịch vụ: 5 Beer · hết hạn 18/10/2026 (còn 15 ngày)')
    expect(out).toMatch(/Embeddings\s+█+[▏▎▍▌▋▊▉]?░* 997\.081 \/ 1\.000\.000/)
    expect(out).toMatch(/Search\s+█+[▏▎▍▌▋▊▉]?░* 9\.992 \/ 10\.000/)
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(INVOICE)
  }
  const full = String((await $.command.run(ctxArgs(''))).text)
  expect(full).toContain('Engine: đang chạy')
  expect(full).toContain('Gốc dự án: E:\\Dev\\www\\Proj')

  fake.usage = { status: 200, body: { expires_at: '2026-10-18', openai_budget: 10000, openai_remaining: 0, voyage_budget: 1000000, voyage_remaining: 5 } }
  const out = String((await $.command.run(ctxArgs('goi'))).text)
  expect(out).toContain('http://127.0.0.1:6699')
})
