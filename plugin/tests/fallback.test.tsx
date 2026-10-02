import { expect, test } from 'claude-code/testing'

import { setup } from './fake-engine'

const WIN = { cwd: 'E:\\Dev\\www\\Proj', top: 'E:/Dev/www/Proj', repos: ['e:\\dev\\www\\proj'] } as const
const session = { cwd: WIN.cwd, surface: null, isInteractive: false } as const
const TOOL = 'mcp__viber-context__codebase_retrieval'
const FILE_TOOL = 'mcp__viber-context__file_retrieval'

const use = (tool: string, id = 'tu1') => ({
  plugin: 'viber-context',
  surface: 'terminal',
  component: 'ToolUse',
  props: { tool_use_id: id, tool, input: { information_request: 'q' }, isRunning: false, isErrored: false, isInterrupted: false },
}) as const

const result = (id: string, tool = TOOL) => ({
  plugin: 'viber-context',
  surface: 'terminal',
  component: 'ToolResult',
  props: { tool_use_id: id, tool, output: 'raw', isErrored: false },
}) as const

const call = (tool: string, id: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: id, tool, input: { information_request: 'q', ...extra }, isRunning: false, isErrored: false, isInterrupted: false,
})

const group = (calls: ReturnType<typeof call>[]) => ({
  plugin: 'viber-context',
  surface: 'terminal',
  component: 'ToolGroup',
  props: { calls, isActive: false, isExpanded: false },
}) as const

test('a malformed call draws a failed card with the reason, and says so to Claude', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session)
  await fake.clock.advance(5000)

  const ran = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: '  ' })
  const file = await $.tool.call({ tool: FILE_TOOL, tool_use_id: 'tu2', file_path: '', information_request: 'x' })
  await fake.clock.settle()

  expect(String(ran.result)).toContain('Thiếu information_request')
  expect(String(file.result)).toContain('Thiếu file_path')
  const ui = await $.ui.mount(use(TOOL, 'tu1'))
  expect(await ui.find({ type: 'Text', text: '✗' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'failed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Missing information_request.' })).toBeDefined()
  const other = await $.ui.mount(use(FILE_TOOL, 'tu2'))
  expect(await other.find({ type: 'Text', text: 'Missing file_path or information_request.' })).toBeDefined()
  // The card carries the reason, so the raw row is hidden.
  expect(await (await $.ui.mount(result('tu1'))).findAll({ type: 'Text' })).toHaveLength(0)
})

test('an engine error draws a failed card', async ($, on) => {
  const fake = setup(on, WIN)
  await $.session.start(session)
  await fake.clock.advance(5000)
  fake.mcpStatus = 500
  fake.mcpResult = 'boom'
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'q' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL))
  expect(await ui.find({ type: 'Text', text: '✗' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Engine error (HTTP 500). Use Grep / Read instead.' })).toBeDefined()
})

test('a quota skip is drawn skipped, not failed', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 0 })
  await $.session.start(session)
  await fake.clock.advance(5000)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', information_request: 'q' })
  await fake.clock.settle()

  const ui = await $.ui.mount(use(TOOL))
  expect(await ui.find({ type: 'Text', text: 'skipped' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'failed' })).toBeUndefined()
})

test('a finished call with no record is neutral, never a green tick', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session)
  const ui = await $.ui.mount(use(TOOL, 'from-an-earlier-session'))

  expect(await ui.find({ type: 'Text', text: '•' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeUndefined()
})

test('a result with no card record keeps the default row', async ($, on) => {
  setup(on, WIN)
  on('ui.render', { component: 'ToolResult', surface: 'terminal' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>default result row</Text>
  })
  await $.session.start(session)

  const ui = await $.ui.mount(result('from-an-earlier-session'))
  expect(await ui.find({ type: 'Text', text: 'default result row' })).toBeDefined()
})

test('a folded group holding a retrieval call is unfolded; one without passes through', async ($, on) => {
  setup(on, WIN)
  const seen: boolean[] = []
  on('ui.render', { component: 'ToolGroup', surface: 'terminal' }, ($, e) => {
    seen.push(e.props.isExpanded)
    const { Text } = $.ui.resolve(e)
    return <Text>group drawn</Text>
  })
  await $.session.start(session)

  await $.ui.mount(group([call('Read', 'r1'), call(TOOL, 'tu1')]))
  expect(seen).toEqual([true])

  await $.ui.mount(group([call('Read', 'r1'), call('Grep', 'g1')]))
  expect(seen).toEqual([true, false])
})
