import { expect, test } from 'claude-code/testing'

import { isScratchPath, normalizeRepo } from '../hooks/lib'
import { ctxArgs, setup } from './fake-engine'

const WIN_TEMP = normalizeRepo('C:\\Users\\Admin\\AppData\\Local\\Temp')
const DESKTOP_WIN = 'C:\\Users\\Admin\\AppData\\Roaming\\Claude\\scratch-workspaces\\0a1b2c3d-1111-2222-3333-444455556666\\scratch-2026-10-02-734fe6'
const DESKTOP_MAC = '/Users/dev/Library/Application Support/Claude/scratch-workspaces/0a1b2c3d-1111/scratch-2026-10-02-734fe6'
const scratch = (p: string, temps: readonly string[] = []) => isScratchPath(normalizeRepo(p), temps)

test('Desktop scratch workspaces are throwaway, on Windows and macOS', () => {
  expect(scratch(DESKTOP_WIN)).toBe(true)
  expect(scratch(DESKTOP_MAC)).toBe(true)
  expect(scratch('C:/Users/Admin/AppData/Roaming/CLAUDE/Scratch-Workspaces/x')).toBe(true)
})

test('the temp directory and anything inside it are throwaway', () => {
  expect(scratch('C:\\Users\\Admin\\AppData\\Local\\Temp', [WIN_TEMP])).toBe(true)
  expect(scratch('C:\\Users\\Admin\\AppData\\Local\\Temp\\job\\proj', [WIN_TEMP])).toBe(true)
  expect(scratch('/var/folders/ab/T/proj', ['/var/folders/ab/T'])).toBe(true)
})

test('ordinary projects are not throwaway', () => {
  expect(scratch('E:\\Dev\\www\\Browzy', [WIN_TEMP])).toBe(false)
  expect(scratch('e:\\dev\\scratch-app', [WIN_TEMP])).toBe(false)
  expect(scratch('E:\\Dev\\Claude\\scratch-workspaces-demo')).toBe(false)
  expect(scratch('E:\\Dev\\scratch-workspaces\\proj')).toBe(false)
  // A sibling that merely shares the temp prefix is not inside it.
  expect(scratch('C:\\Users\\Admin\\AppData\\Local\\Temporary', [WIN_TEMP])).toBe(false)
})

test('empty or root temp values never mark everything as throwaway', () => {
  expect(scratch('E:\\Dev\\www\\Browzy', ['', 'e:', '/', '\\'])).toBe(false)
})

for (const [name, cwd, env] of [
  ['Desktop scratch workspace', DESKTOP_WIN, {}],
  ['directory under TEMP', 'C:\\Users\\Admin\\AppData\\Local\\Temp\\job', { TEMP: 'C:\\Users\\Admin\\AppData\\Local\\Temp' }],
  ['TMPDIR itself', '/tmp/work', { TMPDIR: '/tmp/' }],
] as const) {
  test(`${name}: skipped, no engine, no registration, tools unavailable, placement untouched`, async ($, on) => {
    on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true }))
    const fake = setup(on, { cwd, top: null, env })
    await $.session.start({ cwd, surface: null, isInteractive: false })
    await fake.clock.advance(30_000)

    expect(fake.calls).toHaveLength(0)
    expect(fake.starts).toHaveLength(0)
    expect(fake.statuses).toHaveLength(0)
    const tool = 'mcp__viber-context__codebase_retrieval'
    const described = await $.tool.describe({ tool, description: 'd', isDeferred: true, provider: { plugin: 'viber-context', tier: 'user' } })
    expect(described.isDeferred).toBe(true)
    const ran = await $.tool.call({ tool, information_request: 'x' })
    expect(String(ran.result)).toContain('thư mục tạm')
    expect(fake.calls).toHaveLength(0)
    const on1 = await $.command.run(ctxArgs('on'))
    expect(on1.text).toContain('thư mục tạm')
    expect(fake.calls).toHaveLength(0)
  })
}
