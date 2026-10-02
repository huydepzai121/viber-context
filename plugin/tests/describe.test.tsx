import { expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import { attachmentInput, composeInput, contextInput, ctxArgs, setup } from './fake-engine'

const WIN = { cwd: 'E:\Dev\www\Proj', top: 'E:/Dev/www/Proj', repos: ['e:\dev\www\proj'] } as const
const session = (cwd: string) => ({ cwd, surface: null, isInteractive: false }) as const
const TOOLS = ['mcp__viber-context__codebase_retrieval', 'mcp__viber-context__file_retrieval'] as const

// What the engine itself answers: an MCP tool waits behind ToolSearch.
const engineDescribes = (on: Parameters<typeof setup>[0]) =>
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true }))

const describe = ($: Engine, tool: string) =>
  $.tool.describe({ tool, description: 'd', isDeferred: true, provider: { plugin: 'viber-context', tier: 'user' } })

test('enabled project: both tools are moved into the prompt list', async ($, on) => {
  engineDescribes(on)
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))

  for (const tool of TOOLS) expect((await describe($, tool)).isDeferred).toBe(false)
})

test('/ctx off gives the placement back to the engine, /ctx on takes it again', async ($, on) => {
  engineDescribes(on)
  const fake = setup(on, WIN)
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(5000)

  await $.command.run(ctxArgs('off'))
  expect((await describe($, TOOLS[0])).isDeferred).toBe(true)
  await $.command.run(ctxArgs('on'))
  expect((await describe($, TOOLS[0])).isDeferred).toBe(false)
  await fake.clock.advance(5000)
})

test('home root keeps the engine placement', async ($, on) => {
  engineDescribes(on)
  setup(on, { cwd: 'C:\Users\Admin', top: null, home: 'C:\Users\Admin' })
  await $.session.start(session('C:\Users\Admin'))

  for (const tool of TOOLS) expect((await describe($, tool)).isDeferred).toBe(true)
})

test('other tools are not touched and the section covers overview questions', async ($, on) => {
  engineDescribes(on)
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))

  expect((await describe($, 'mcp__someone__else')).isDeferred).toBe(true)
  const text = (await $.prompt.compose(composeInput)).sections.at(-1)?.text ?? ''
  expect(text).toContain('analyze or review the project')
  expect(text).toContain('architecture overview')
  expect(text).toContain('before Bash, ls, cat, git diff, Glob or reading files')
  expect(text).not.toContain('speculatively')
  expect(text).not.toContain('Skip retrieval')
})

const CTX_BLOCK = 'viberContext'
const context = ($: Engine) => $.prompt.context(contextInput)
const DELTA = [
  'The following deferred tools are now available via ToolSearch. Load them first:',
  'LSP',
  'mcp__viber-context__codebase_retrieval',
  'mcp__other__tool',
  'mcp__viber-context__file_retrieval',
].join('\n')

test('prompt.context appends the instruction block after the existing ones', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))

  const blocks = (await context($)).blocks
  expect(blocks.map(b => b.name)).toEqual(['claudeMd', 'userEmail', CTX_BLOCK])
  expect(blocks[0].text).toBe('rules')
  expect(blocks[2].text).toContain('ALWAYS call mcp__viber-context__codebase_retrieval FIRST')
  expect(blocks[2].text).toContain('instead of the Explore subagent')
})

test('prompt.context adds nothing when off, skipped or the plan is used up', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))
  await $.command.run(ctxArgs('off'))
  expect((await context($)).blocks.map(b => b.name)).toEqual(['claudeMd', 'userEmail'])
})

test('prompt.context skips a home directory', async ($, on) => {
  setup(on, { cwd: 'C:\Users\Admin', top: null, home: 'C:\Users\Admin' })
  await $.session.start(session('C:\Users\Admin'))
  expect((await context($)).blocks.map(b => b.name)).toEqual(['claudeMd', 'userEmail'])
})

test('prompt.context adds nothing when no searches are left or the plan expired', async ($, on) => {
  const fake = setup(on, { ...WIN, searchLeft: 0 })
  await $.session.start(session(WIN.cwd))
  await fake.clock.advance(10_000)
  expect((await context($)).blocks.map(b => b.name)).toEqual(['claudeMd', 'userEmail'])
})

test('deferred_tools_delta loses only the retrieval tool lines', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))

  const out = await $.prompt.attachment(attachmentInput('deferred_tools_delta', DELTA))
  expect(out.text).toBe(['The following deferred tools are now available via ToolSearch. Load them first:', 'LSP', 'mcp__other__tool'].join('\n'))
})

test('deferred_tools_delta that lists only the retrieval tools is left out', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))

  const text = ['Heads up:', 'mcp__viber-context__codebase_retrieval', 'mcp__viber-context__file_retrieval'].join('\n')
  expect((await $.prompt.attachment(attachmentInput('deferred_tools_delta', text))).text).toBeNull()
})

test('deferred_tools_delta is untouched when off, and other attachments always are', async ($, on) => {
  setup(on, WIN)
  await $.session.start(session(WIN.cwd))
  const other = await $.prompt.attachment(attachmentInput('todo_reminder', DELTA))
  expect(other.text).toBe(DELTA)

  await $.command.run(ctxArgs('off'))
  const off = await $.prompt.attachment(attachmentInput('deferred_tools_delta', DELTA))
  expect(off.text).toBe(DELTA)
})
