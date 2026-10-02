import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { IndexInfo, Mode, PlanInfo } from '../types'
import {
  ENGINE, ENGINE_PORT, PROMPT_SECTION, PROMPT_SECTION_UNAVAILABLE, daysLeft, isFilesystemRoot, isWindowsPath,
  normalizeRepo, planBlock, planLevel, repoId, vn, withFilters,
} from './lib'

const PLUGIN = 'viber-context'
const RETRIEVAL = 'codebase_retrieval'
const RETRIEVAL_ID = `mcp__${PLUGIN}__${RETRIEVAL}`
const FILE_RETRIEVAL = 'file_retrieval'
const FILE_RETRIEVAL_ID = `mcp__${PLUGIN}__${FILE_RETRIEVAL}`
const BOOT_POLLS = 20
const BOOT_POLL_MS = 1000
const INDEX_POLL_MS = 3000
const INDEX_MAX_MS = 10 * 60 * 1000
const PLAN_POLL_MS = 10 * 60 * 1000
// Idle polls to wait before an index run that never showed a busy state counts as done.
const IDLE_GRACE_TICKS = 3

const rootAtom = atom({ plugin: 'viber-context', key: 'root' } as const, '')
// 'on' retrieval is wired up; 'off' the person turned it off for this root;
// 'skipped' the directory is a home or filesystem root, never indexed.
const modeAtom = atom({ plugin: 'viber-context', key: 'mode' } as const, 'skipped' as Mode)
const engineAtom = atom({ plugin: 'viber-context', key: 'engine' } as const, 'unknown' as 'unknown' | 'up' | 'down')
const indexAtom = atom(
  { plugin: 'viber-context', key: 'index' } as const,
  { state: '', indexed: 0, total: 0, done: false, error: '', baseline: '', sawBusy: false, ticks: 0, startedAt: 0 } as IndexInfo,
)
const faultAtom = atom({ plugin: 'viber-context', key: 'fault' } as const, '')
const NO_PLAN: PlanInfo = { known: false, name: '', expiresAt: 0, searchLeft: 0, searchLimit: 0, embedLeft: 0, embedLimit: 0 }
const planAtom = atom({ plugin: 'viber-context', key: 'plan' } as const, NO_PLAN)
const alertedAtom = atom({ plugin: 'viber-context', key: 'alerted' } as const, 0)

// Timers outlive any one hook call; one of each at a time.
let poller: Timer | undefined
let planTimer: Timer | undefined

type Fields = Record<string, unknown>
const fields = (v: unknown): Fields => (typeof v === 'object' && v !== null ? (v as Fields) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

type Api = { ok: boolean; status: number; body: string }

// One engine call; a refused connection answers status 0, never throws.
async function api($: EngineInterface, method: string, path: string, body?: unknown, auth?: string): Promise<Api> {
  const headers: Record<string, string> = {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(auth === undefined ? {} : { authorization: auth }),
  }
  try {
    const res = await $.http.fetch(`${ENGINE}${path}`, {
      method,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { ok: res.ok, status: res.status, body: res.text }
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }
  }
}

const parse = (body: string): Fields => {
  try {
    return fields(JSON.parse(body))
  } catch {
    return {}
  }
}

// Work that outlives the hook that started it: a failure there has no caller to tell.
function detach(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

const isUp = async ($: EngineInterface): Promise<boolean> => (await api($, 'GET', '/api/repos')).ok

function stopPolling(): void {
  poller?.cancel()
  poller = undefined
}

function stopPlanTimer(): void {
  planTimer?.cancel()
  planTimer = undefined
}

async function setIndex($: EngineInterface, patch: Partial<IndexInfo>): Promise<void> {
  await update($, indexAtom, cur => ({ ...cur, ...patch }))
}

function indexLine(info: IndexInfo): string {
  if (info.error) return 'ctx ✗ lỗi lập chỉ mục'
  if (info.done) return `ctx ● ${vn(info.indexed)} file`
  if (info.startedAt === 0) return 'ctx ◌ đang khởi động'
  return `ctx ◌ lập chỉ mục ${vn(info.indexed)}/${vn(info.total)}`
}

// The one status line: a fault, else the index part with the plan's numbers.
async function refreshStatus($: EngineInterface): Promise<void> {
  if ((await read($, modeAtom)) !== 'on') {
    $.ui.status(undefined)
    return
  }
  const fault = await read($, faultAtom)
  if (fault !== '') {
    $.ui.status(fault)
    return
  }
  const plan = await read($, planAtom)
  const now = await $.clock.now()
  const level = planLevel(plan, now)
  if (level === 'expired') return $.ui.status('ctx ✗ gói đã hết hạn')
  if (level === 'out') return $.ui.status('ctx ✗ hết lượt search')
  const parts = [indexLine(await read($, indexAtom))]
  if (plan.known) {
    parts.push(`còn ${vn(plan.searchLeft)} search`)
    if (plan.expiresAt > 0) parts.push(`${daysLeft(plan.expiresAt, now)} ngày`)
  }
  $.ui.status(`${level === 'warn' ? '⚠ ' : ''}${parts.join(' · ')}`)
}

async function setFault($: EngineInterface, line: string): Promise<void> {
  await update($, faultAtom, () => line)
  await refreshStatus($)
}

// The active plan (the one on the engine's embedding endpoint, else the
// latest-expiring) and its usage. The proxy key stays in this function: it is
// sent as the Authorization header and never stored, shown or logged.
async function refreshPlan($: EngineInterface): Promise<void> {
  let next: PlanInfo = NO_PLAN
  try {
    const cfg = parse((await api($, 'GET', '/api/config')).body)
    const plans = Array.isArray(cfg.purchased_plans) ? cfg.purchased_plans.map(fields) : []
    const base = text(fields(cfg.embedding).voyage_base_url)
    const latest = [...plans].sort((a, b) => num(b.expires_at) - num(a.expires_at))[0]
    const pick = (base === '' ? undefined : plans.find(p => text(p.base_url) === base)) ?? latest
    const key = pick === undefined ? '' : text(pick.proxy_key)
    if (pick !== undefined && key !== '') {
      const res = await api($, 'GET', '/api/plan/usage', undefined, `Bearer ${key}`)
      const usage = parse(res.body)
      if (res.ok && typeof usage.openai_remaining === 'number' && typeof usage.openai_budget === 'number') {
        const expiresAt = num(pick.expires_at) || Date.parse(text(usage.expires_at)) || 0
        next = {
          known: true,
          name: text(pick.package_name),
          expiresAt,
          searchLeft: num(usage.openai_remaining),
          searchLimit: num(usage.openai_budget),
          embedLeft: num(usage.voyage_remaining),
          embedLimit: num(usage.voyage_budget),
        }
      }
    }
  } catch {
    // Unknown plan: the status line shows the index part only.
  }
  await update($, planAtom, () => next)
  await alertOnce($, next)
  await refreshStatus($)
}

// One toast per session for each step worse: warning, then exhausted or expired.
async function alertOnce($: EngineInterface, plan: PlanInfo): Promise<void> {
  const level = planLevel(plan, await $.clock.now())
  const rank = level === 'ok' ? 0 : level === 'warn' ? 1 : 2
  if (rank <= (await read($, alertedAtom))) return
  await update($, alertedAtom, () => rank)
  if (level === 'warn') $.ui.toast(`Gói context engine sắp hết: còn ${vn(plan.searchLeft)} search, ${daysLeft(plan.expiresAt, await $.clock.now())} ngày.`)
  else if (level === 'out') $.ui.toast('Gói context engine đã hết lượt search. Mua thêm trong giao diện web của engine.')
  else $.ui.toast('Gói context engine đã hết hạn. Gia hạn trong giao diện web của engine.')
}

function startPlanTimer($: EngineInterface): void {
  stopPlanTimer()
  planTimer = $.clock.every(PLAN_POLL_MS, () => {
    detach(refreshPlan($))
  })
}

// The engine, started detached so it outlives the session, only when its
// health answer is missing; then 1 s polls for up to 20 s.
async function ensureEngine($: EngineInterface, windows: boolean): Promise<boolean> {
  if (await isUp($)) {
    await update($, engineAtom, () => 'up')
    return true
  }
  const argv = windows
    ? ['powershell', '-NoProfile', '-Command', `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','vibervn-context-engine --port ${ENGINE_PORT}' -WindowStyle Hidden`]
    : ['sh', '-c', `nohup vibervn-context-engine --port ${ENGINE_PORT} >/dev/null 2>&1 &`]
  try {
    await $.process.run(argv, { timeoutMs: 15_000 })
  } catch {
    // The health polls below decide; a start that did not take just times out.
  }
  for (let i = 0; i < BOOT_POLLS; i += 1) {
    await $.clock.sleep(BOOT_POLL_MS)
    if (await isUp($)) {
      await update($, engineAtom, () => 'up')
      return true
    }
  }
  await update($, engineAtom, () => 'down')
  return false
}

type Registration = 'present' | 'added' | 'failed'

// Appends the root to the engine's repos; every other field goes back exactly
// as read. Repos are never removed.
async function ensureRegistered($: EngineInterface, norm: string): Promise<Registration> {
  const got = await api($, 'GET', '/api/config')
  if (!got.ok) return 'failed'
  const config = parse(got.body)
  const repos = Array.isArray(config.repos) ? config.repos.filter((r): r is string => typeof r === 'string') : null
  if (repos === null) return 'failed'
  if (repos.includes(norm)) return 'present'
  const put = await api($, 'PUT', '/api/config', { ...config, repos: [...repos, norm] })
  return put.ok ? 'added' : 'failed'
}

const IDLE_STATES = new Set(['idle', 'indexed'])

async function pollOnce($: EngineInterface, norm: string): Promise<void> {
  try {
    const cur = await read($, indexAtom)
    if ((await $.clock.now()) - cur.startedAt > INDEX_MAX_MS) {
      stopPolling()
      await setFault($, 'ctx ◌ lập chỉ mục quá lâu, /ctx để xem')
      return
    }
    const res = await api($, 'GET', `/api/repos/${repoId(norm)}/status`)
    if (!res.ok) return
    const s = parse(res.body)
    const state = text(s.state)
    const ticks = cur.ticks + 1
    const sawBusy = cur.sawBusy || (state !== '' && state !== 'error' && !IDLE_STATES.has(state))
    const settled = IDLE_STATES.has(state) && (sawBusy || text(s.last_indexed_at) !== cur.baseline || ticks >= IDLE_GRACE_TICKS)
    await setIndex($, {
      state,
      indexed: typeof s.indexed_files === 'number' ? s.indexed_files : cur.indexed,
      total: typeof s.total_files === 'number' ? s.total_files : cur.total,
      error: state === 'error' ? text(s.error) || 'error' : '',
      sawBusy,
      ticks,
      done: settled,
    })
    await refreshStatus($)
    if (settled || state === 'error') stopPolling()
  } catch {
    // A failed poll is retried on the next tick.
  }
}

// One incremental index run for the root, then a status poll every 3 s.
async function startIndex($: EngineInterface, norm: string): Promise<boolean> {
  const id = repoId(norm)
  const before = parse((await api($, 'GET', `/api/repos/${id}/status`)).body)
  const started = await api($, 'POST', `/api/repos/${id}/index`)
  if (!started.ok) {
    await setFault($, 'ctx ✗ không lập chỉ mục được')
    return false
  }
  await update($, indexAtom, () => ({
    state: 'queued', indexed: 0, total: 0, done: false, error: '',
    baseline: text(before.last_indexed_at), sawBusy: false, ticks: 0, startedAt: 0,
  }))
  await setIndex($, { startedAt: await $.clock.now() })
  await setFault($, '')
  stopPolling()
  poller = $.clock.every(INDEX_POLL_MS, () => {
    detach(pollOnce($, norm))
  })
  return true
}

// Engine up, repo registered, index started, plan watched: the whole pipeline.
async function boot($: EngineInterface, norm: string, windows: boolean): Promise<void> {
  try {
    await refreshStatus($)
    if (!(await ensureEngine($, windows))) return await setFault($, 'ctx ✗ engine chưa chạy')
    startPlanTimer($)
    detach(refreshPlan($))
    if ((await ensureRegistered($, norm)) === 'failed') return await setFault($, 'ctx ✗ không đăng ký được repo')
    await startIndex($, norm)
  } catch {
    await setFault($, 'ctx ✗ lỗi khởi động')
  }
}

// Git's top level, else the cwd itself.
async function projectRoot($: EngineInterface, cwd: string): Promise<string> {
  try {
    const res = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    const top = res.stdout.trim()
    if (res.exitCode === 0 && top !== '') return isWindowsPath(top) ? top.replace(/\//g, '\\') : top
  } catch {
    // No git: the cwd is the project.
  }
  return cwd
}

async function isHome($: EngineInterface, norm: string): Promise<boolean> {
  const homes = [await $.env.get('USERPROFILE'), await $.env.get('HOME')]
  return homes.some(h => typeof h === 'string' && h !== '' && normalizeRepo(h) === norm)
}

const disabledKey = (norm: string): string => `disabled:${norm}`

const reply = (body: string) => ({ result: body, text: body })

const fallback = (why: string): string =>
  `Không truy xuất được codebase qua context engine (${why}). Hãy dùng Grep/Glob/Read để tìm code thay thế.`

// The shared body of both tools: gate on mode and plan, post to the engine, relay `result`.
async function retrieve($: EngineInterface, path: string, payload: Fields): Promise<string> {
  const mode = await read($, modeAtom)
  if (mode === 'skipped') return fallback('thư mục này là thư mục home hoặc gốc ổ đĩa nên không được lập chỉ mục')
  if (mode === 'off') return 'Truy xuất codebase đang tắt cho dự án này (/ctx on để bật lại). Hãy dùng Grep/Glob/Read.'
  const level = planLevel(await read($, planAtom), await $.clock.now())
  if (level === 'expired') return fallback('gói dịch vụ của context engine đã hết hạn, không gọi engine')
  if (level === 'out') return fallback('đã hết lượt search của gói dịch vụ, không gọi engine')
  const root = await read($, rootAtom)
  const res = await api($, 'POST', path, { ...payload, workspace_full_path: root })
  if (res.status === 0) return fallback('engine chưa chạy')
  // The engine answered, so a search was spent (or refused): refresh the numbers.
  detach(refreshPlan($))
  if (!res.ok) return fallback(`engine trả HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const out = parse(res.body).result
  return typeof out === 'string' ? out : res.body
}

async function describeState($: EngineInterface, planOnly: boolean): Promise<string> {
  const root = await read($, rootAtom)
  const mode = await read($, modeAtom)
  const lines: string[] = []
  const up = await isUp($)
  if (up) await refreshPlan($)
  const plan = planBlock(await read($, planAtom), await $.clock.now())
  if (planOnly) return plan
  lines.push(`Engine: ${up ? `đang chạy (${ENGINE})` : 'chưa chạy'}`)
  lines.push(`Gốc dự án: ${root || '(chưa xác định)'}`)
  lines.push(`Tự lập chỉ mục: ${mode === 'on' ? 'bật' : mode === 'off' ? 'tắt (/ctx on để bật)' : 'bỏ qua (thư mục home hoặc gốc ổ đĩa)'}`)
  if (up && root !== '') {
    const norm = normalizeRepo(root)
    const config = parse((await api($, 'GET', '/api/config')).body)
    const registered = Array.isArray(config.repos) && config.repos.includes(norm)
    lines.push(`Đăng ký: ${registered ? 'rồi' : 'chưa'} (${norm})`)
    if (registered) {
      const s = parse((await api($, 'GET', `/api/repos/${repoId(norm)}/status`)).body)
      lines.push(`Chỉ mục: ${text(s.state) || '?'}, ${vn(num(s.indexed_files))}/${vn(num(s.total_files))} file`)
    }
  }
  lines.push('', plan)
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: RETRIEVAL,
      description: [
        'Semantic search over this project\'s indexed codebase (local context engine). Describe what you need in natural language and it returns the most relevant code snippets with file paths and line ranges.',
        'Use it for "where / how is X done" questions about THIS codebase, and before editing code you have not read: write one detailed request (what, where, why) instead of reading many files.',
        'Do NOT use it for exact identifiers, strings or file names (use Grep/Glob) or for questions that are not about the code. Each search uses a limited paid quota, so avoid near-identical repeats.',
        'Optional filters: filter_kind (e.g. function, class), filter_lang (e.g. typescript, rust), filter_path (a path prefix such as src/api).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['information_request'],
        properties: {
          information_request: { type: 'string', description: 'What you are looking for, in detail: the behavior, where it likely lives, and why you need it.' },
          filter_kind: { type: 'array', items: { type: 'string' }, description: 'Only these symbol kinds, e.g. function, class.' },
          filter_lang: { type: 'array', items: { type: 'string' }, description: 'Only these languages, e.g. typescript.' },
          filter_path: { type: 'string', description: 'Only files under this path prefix, e.g. src/api.' },
        },
      },
    })
    await $.tool.register({
      name: FILE_RETRIEVAL,
      description: [
        'Find the relevant lines inside ONE known file of this project (local context engine) instead of reading the whole file.',
        'Use it when you know which file matters but not where in it; describe what you need in information_request.',
        'Do NOT use it to discover which file to look in (use codebase_retrieval) or for exact strings (use Grep).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['file_path', 'information_request'],
        properties: {
          file_path: { type: 'string', description: 'The file, relative to the project root.' },
          information_request: { type: 'string', description: 'What you are looking for inside the file.' },
          top_k: { type: 'integer', description: 'How many snippets to return at most.' },
        },
      },
    })
    await $.command.register({
      name: 'ctx',
      description: 'Trạng thái context engine và gói dịch vụ; reindex lập chỉ mục lại, goi chỉ xem gói, on/off bật tắt cho dự án này',
      argumentHint: '[reindex|goi|on|off]',
    })

    const cwd = await $.session.cwd()
    const root = await projectRoot($, cwd)
    const norm = normalizeRepo(root)
    await update($, rootAtom, () => root)
    const skipped = isFilesystemRoot(norm) || (await isHome($, norm))
    const disabled = !skipped && (await $.store.get(disabledKey(norm))) === true
    const mode: Mode = skipped ? 'skipped' : disabled ? 'off' : 'on'
    await update($, modeAtom, () => mode)
    if (mode === 'on') {
      // Booting can take a while (engine start); the session does not wait for it.
      detach(boot($, norm, isWindowsPath(root)))
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, modeAtom)) !== 'on') return composed
    const level = planLevel(await read($, planAtom), await $.clock.now())
    const body = level === 'out' || level === 'expired' ? PROMPT_SECTION_UNAVAILABLE : PROMPT_SECTION
    return { sections: [...composed.sections, { id: 'viber-context:retrieval', text: body, scope: 'session' as const }] }
  })

  on('tool.call', { tool: RETRIEVAL_ID }, async ($, e) => {
    const input = fields(e)
    if (text(input.information_request).trim() === '') return reply('Thiếu information_request. Hãy mô tả chi tiết thứ cần tìm.')
    return reply(await retrieve($, '/api/mcp-tool', { information_request: withFilters(input) }))
  })

  on('tool.call', { tool: FILE_RETRIEVAL_ID }, async ($, e) => {
    const input = fields(e)
    if (text(input.file_path).trim() === '' || text(input.information_request).trim() === '') {
      return reply('Thiếu file_path hoặc information_request.')
    }
    const top = typeof input.top_k === 'number' && Number.isFinite(input.top_k) ? { top_k: Math.max(1, Math.round(input.top_k)) } : {}
    return reply(await retrieve($, '/api/mcp-tool/file-retrieval', {
      file_path: text(input.file_path).trim(),
      information_request: text(input.information_request).trim(),
      ...top,
    }))
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const root = await read($, rootAtom)
    const norm = normalizeRepo(root)
    const mode = await read($, modeAtom)
    if (arg === 'off' || arg === 'on') {
      if (mode === 'skipped') return { text: 'Thư mục này là thư mục home hoặc gốc ổ đĩa, không được lập chỉ mục.' }
      await $.store.set(disabledKey(norm), arg === 'off')
      await update($, modeAtom, () => (arg === 'off' ? 'off' : 'on'))
      if (arg === 'off') {
        stopPolling()
        stopPlanTimer()
        await refreshStatus($)
        return { text: 'Đã tắt tự lập chỉ mục và truy xuất codebase cho dự án này. /ctx on để bật lại.' }
      }
      detach(boot($, norm, isWindowsPath(root)))
      return { text: 'Đã bật lại; đang khởi động engine, đăng ký và lập chỉ mục cho dự án này.' }
    }
    if (arg === 'reindex') {
      if (mode !== 'on') return { text: 'Tự lập chỉ mục đang tắt hoặc bị bỏ qua cho thư mục này (/ctx on để bật).' }
      if (!(await ensureEngine($, isWindowsPath(root)))) return { text: 'Engine chưa chạy và không khởi động được.' }
      if ((await ensureRegistered($, norm)) === 'failed') return { text: 'Không đăng ký được repo với engine.' }
      return { text: (await startIndex($, norm)) ? 'Đã yêu cầu lập chỉ mục lại; trạng thái ở dòng ctx.' : 'Engine từ chối yêu cầu lập chỉ mục.' }
    }
    return { text: await describeState($, arg === 'goi') }
  })
}
