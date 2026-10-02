import { expect, test } from 'claude-code/testing'

import { parseRetrieval, shortPath } from '../hooks/lib'
import { setup } from './fake-engine'

const WIN = { cwd: 'E:\\Dev\\www\\Proj', top: 'E:/Dev/www/Proj', repos: ['e:\\dev\\www\\proj'] } as const
const session = { cwd: WIN.cwd, surface: null, isInteractive: false } as const
const TOOL = 'mcp__viber-context__codebase_retrieval'
const FILE_TOOL = 'mcp__viber-context__file_retrieval'

// Shaped like the engine's output: `path#Lstart-end [callers: ..] [calls: ..]`,
// numbered code lines, blocks separated by a blank line.
const SAMPLE = [
  'E:\\Dev\\www\\Proj\\src\\auth\\token.ts#L10-12 [callers: refresh, login +2 more] [calls: sign]',
  '10: export function refreshToken(user: User) {',
  '11:   return sign(user)',
  '12: }',
  '',
  'E:\\Dev\\www\\Proj\\src\\api\\client.ts#L5-6 [callers:3]',
  '5: export const client = {',
  '6: }',
].join('\n')

const use = (tool: string, request: string, props: Record<string, boolean> = {}) => ({
  plugin: 'viber-context',
  surface: 'terminal',
  component: 'ToolUse',
  props: { tool_use_id: 'tu1', tool, input: { information_request: request }, isRunning: false, isErrored: false, isInterrupted: false, ...props },
}) as const

test('the engine text parses into blocks, tags and paths', () => {
  const parsed = parseRetrieval(SAMPLE)
  expect(parsed.chunks).toBe(2)
  expect(parsed.rows[0]).toEqual({
    path: 'E:\\Dev\\www\\Proj\\src\\auth\\token.ts', start: 10, end: 12,
    symbol: 'export function refreshToken(user: User) {', callers: 'refresh, login +2 more', calls: 'sign',
  })
  expect(parsed.rows[1]?.callers).toBe('3')
  expect(parseRetrieval('No relevant code found. The indexed codebase does not appear to match.').chunks).toBe(0)
  expect(shortPath('E:\\Dev\\www\\Proj', 'e:/dev/www/proj/src/a.ts')).toBe('src/a.ts')
})

test('the card shows header, result rows and the searches left', async ($, on) => {
  const fake = setup(on, WIN)
  fake.mcpResult = { result: SAMPLE }
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'how are tokens refreshed' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL, 'how are tokens refreshed'))
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◎' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Retrieval' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'how are tokens refreshed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 chunks · 0.0s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/auth/token.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#L10-12' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^export function refreshToken/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '← refresh, login +2 more' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '→ sign' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/api/client.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '9,992 searches left' })).toBeDefined()
})

test('a result that parses to nothing shows no body rows', async ($, on) => {
  const fake = setup(on, WIN)
  fake.mcpResult = { result: 'No relevant code found.' }
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'nothing here' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL, 'nothing here'))
  expect(await ui.find({ type: 'Text', text: '0 chunks · 0.0s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#L\d/ })).toBeUndefined()
})

test('the file retrieval card is labelled as such, and a low quota warns in the footer', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 8 })
  fake.mcpResult = { result: SAMPLE }
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: FILE_TOOL, tool_use_id: 'tu1', file_path: 'src/auth/token.ts', information_request: 'refresh' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(FILE_TOOL, 'refresh'))
  expect(await ui.find({ type: 'Text', text: 'File retrieval' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⚠ 8 searches left' })).toBeDefined()
})

test('a running call draws the blue status and no counts', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session)
  const ui = await $.ui.mount(use(TOOL, 'working on it', { isRunning: true }))

  expect(await ui.find({ type: 'Text', text: '◌' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chunk/ })).toBeUndefined()
})

test('an exhausted quota draws a skipped card with the Grep / Read hint', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 0 })
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'where is auth' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL, 'where is auth'))
  expect(await ui.find({ type: 'Text', text: '✗' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'skipped' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Search quota used up. Use Grep / Read instead; renew the plan at 127.0.0.1:6699.' })).toBeDefined()
})

test('an expired plan says so', async ($, on) => {
  const fake = setup(on, { ...WIN, expiresAt: Date.parse('2026-10-01T00:00:00Z') })
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'x' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL, 'x'))
  expect(await ui.find({ type: 'Text', text: 'Plan expired. Use Grep / Read instead; renew the plan at 127.0.0.1:6699.' })).toBeDefined()
})

test('the raw result row is hidden for these tools', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session)
  const ui = await $.ui.mount({
    plugin: 'viber-context',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'tu1', tool: TOOL, output: SAMPLE, isErrored: false },
  })

  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})
