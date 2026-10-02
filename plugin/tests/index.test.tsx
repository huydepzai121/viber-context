import { expect, test } from 'claude-code/testing'

import { NO_INDEX, duration, eta, progressLine } from '../hooks/lib'
import { setup } from './fake-engine'

const WIN = { cwd: 'E:\\Dev\\www\\Proj', top: 'E:/Dev/www/Proj', repos: ['e:\\dev\\www\\proj'] } as const
const session = { cwd: WIN.cwd, surface: null, isInteractive: false } as const
const DONE = { state: 'idle', phase: 'idle', indexed_files: 1084, total_files: 1084, last_indexed_at: '2026-10-03T00:05:00Z' }
const embedding = (indexed: number, total: number) => ({ state: 'indexing', phase: 'embedding', indexed_files: indexed, total_files: total, last_indexed_at: null })

test('ETA and duration formats', () => {
  expect(eta(45_000)).toBe('~45s')
  expect(eta(80_000)).toBe('~1m 20s')
  expect(eta(60_000)).toBe('~1m')
  expect(duration(134_000)).toBe('2m 14s')
  expect(duration(3_900_000)).toBe('1h 5m')
})

test('progress lines by phase, first run and later run', () => {
  const run = { ...NO_INDEX, startedAt: 1, state: 'indexing', phase: 'embedding' }
  expect(progressLine(NO_INDEX)).toBe('ctx ◌ đang bật engine…')
  expect(progressLine({ ...run, first: true })).toBe('ctx ◌ lần đầu lập chỉ mục · đang quét file…')
  expect(progressLine({ ...run, first: true, indexed: 347, total: 1084 })).toBe('ctx ◌ lập chỉ mục ▰▰▰▱▱▱▱▱▱▱ 32% · 347/1.084 file')
  expect(progressLine({ ...run, first: true, indexed: 347, total: 1084, etaMs: 80_000 })).toBe('ctx ◌ lập chỉ mục ▰▰▰▱▱▱▱▱▱▱ 32% · 347/1.084 file · còn ~1m 20s')
  expect(progressLine({ ...run, first: true, phase: 'resolve_edges', indexed: 1084, total: 1084 })).toBe('ctx ◌ nối quan hệ gọi hàm…')
  expect(progressLine({ ...run, first: true, phase: 'symbol_index' })).toBe('ctx ◌ lập chỉ mục…')
  expect(progressLine({ ...run, first: true, phase: 'something_new' })).toBe('ctx ◌ lập chỉ mục…')
  expect(progressLine({ ...run, first: false })).toBe('ctx ◌ kiểm tra thay đổi…')
  expect(progressLine({ ...run, first: false, total: 12 })).toBe('ctx ◌ cập nhật 12 file đã đổi…')
})

test('first run: scanning, bar with percent and ETA, edges, ready line and one toast', async ($, on) => {
  const fake = setup(on, { ...WIN, first: true })
  fake.script = [embedding(0, 0), embedding(347, 1084), embedding(600, 1084), { ...embedding(1084, 1084), phase: 'resolve_edges', phase_total: 0 }, DONE]
  await $.session.start(session)
  await fake.clock.advance(20_000)

  expect(fake.statuses).toContain('ctx ◌ lần đầu lập chỉ mục · đang quét file…')
  // The first sample has no ETA; the second one (253 files in 3 s) does.
  expect(fake.statuses).toContain('ctx ◌ lập chỉ mục ▰▰▰▱▱▱▱▱▱▱ 32% · 347/1.084 file')
  expect(fake.statuses).toContain('ctx ◌ lập chỉ mục ▰▰▰▰▰▰▱▱▱▱ 55% · 600/1.084 file · còn ~6s')
  expect(fake.statuses).toContain('ctx ◌ nối quan hệ gọi hàm…')
  expect(fake.statuses.at(-1)).toMatch(/^ctx ● 1\.084 file/)
  expect(fake.statuses.some(s => s.includes('0/0'))).toBe(false)
  expect(fake.toasts).toEqual(['✓ viber-context: đã lập chỉ mục 1.084 file trong 15s'])
})

test('first run with the engine still starting says so', async ($, on) => {
  const fake = setup(on, { ...WIN, first: true, upAfter: 3 })
  fake.script = [DONE]
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses[0]).toBe('ctx ◌ đang bật engine…')
  expect(fake.statuses.some(s => s.includes('0/0'))).toBe(false)
})

test('later run: no bar, no toast, edits afterwards leave the line alone', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses).toContain('ctx ◌ kiểm tra thay đổi…')
  expect(fake.statuses.some(s => s.includes('▰'))).toBe(false)
  expect(fake.toasts).toHaveLength(0)
  const ready = fake.statuses.at(-1)
  const polled = fake.calls.filter(c => c.path.endsWith('/status')).length
  // Polling stopped: more time, no more status calls, same line.
  await fake.clock.advance(60_000)
  expect(fake.calls.filter(c => c.path.endsWith('/status')).length).toBe(polled)
  expect(fake.statuses.at(-1)).toBe(ready)
})

test('later run with changed files names how many', async ($, on) => {
  const fake = setup(on, WIN)
  fake.script = [{ state: 'indexing', phase: 'embedding', indexed_files: 2, total_files: 12, last_indexed_at: '2026-10-01T00:00:00Z' }, DONE]
  await $.session.start(session)
  await fake.clock.advance(10_000)

  expect(fake.statuses).toContain('ctx ◌ cập nhật 12 file đã đổi…')
  expect(fake.toasts).toHaveLength(0)
})

test('an index run that never ends keeps the plan numbers beside a short note', async ($, on) => {
  const fake = setup(on, WIN)
  fake.script = [embedding(7, 0)]
  await $.session.start(session)
  await fake.clock.advance(11 * 60_000)

  const line = fake.statuses.at(-1)!
  expect(line).toContain('ctx ● 7 file')
  expect(line).toContain('còn 9.992 search')
  expect(line).toContain('· chỉ mục chưa xong (/ctx reindex)')
})
