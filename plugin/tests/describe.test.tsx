import { expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'
import { composeInput, ctxArgs, setup } from './fake-engine'

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
  expect(text).toContain('analyze this project')
  expect(text).toContain('architecture overview')
  expect(text).toContain('never to discover how the code works')
})
