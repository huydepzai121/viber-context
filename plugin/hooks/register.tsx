import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, RenderElement, TextProps, Timer } from 'claude-code'

import type { Card, IndexInfo, Mode, PlanInfo } from '../types'
import {
  CONTEXT_BLOCK, CONTEXT_BLOCK_NAME, ENGINE, ENGINE_PORT, NO_INDEX, PROMPT_SECTION, PROMPT_SECTION_UNAVAILABLE, daysLeft, duration, en, isFilesystemRoot, isScratchPath,
  isWindowsPath, normalizeRepo, parseRetrieval, planBlock, planLevel, progressLine, repoId, shortPath, stripToolNames, vn, withFilters,
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
const FIRST_GRACE_TICKS = 10

const rootAtom = atom({ plugin: 'viber-context', key: 'root' } as const, '')
// 'on' retrieval is wired up; 'off' the person turned it off for this root;
// 'skipped' the directory is a home, filesystem root or throwaway (temp / Desktop scratch) directory, never indexed.
const modeAtom = atom({ plugin: 'viber-context', key: 'mode' } as const, 'skipped' as Mode)
const engineAtom = atom({ plugin: 'viber-context', key: 'engine' } as const, 'unknown' as 'unknown' | 'up' | 'down')
const indexAtom = atom({ plugin: 'viber-context', key: 'index' } as const, NO_INDEX)
const cardsAtom = atom({ plugin: 'viber-context', key: 'cards' } as const, {} as Record<string, Card>)
const MAX_CARDS = 50
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

// The one status line: a fault; the run's progress while it works; once it is
// over (done, timed out or failed) the ready line with the plan's numbers.
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
  const index = await read($, indexAtom)
  if (index.error) return $.ui.status('ctx ✗ lỗi lập chỉ mục')
  if (!index.done && !index.timedOut) return $.ui.status(progressLine(index))
  const plan = await read($, planAtom)
  const now = await $.clock.now()
  const level = planLevel(plan, now)
  if (level === 'expired') return $.ui.status('ctx ✗ gói đã hết hạn')
  if (level === 'out') return $.ui.status('ctx ✗ hết lượt search')
  const parts = [`ctx ● ${vn(index.indexed)} file`]
  if (plan.known) {
    parts.push(`còn ${vn(plan.searchLeft)} search`)
    if (plan.expiresAt > 0) parts.push(`${daysLeft(plan.expiresAt, now)} ngày`)
  }
  if (!index.done) parts.push('chỉ mục chưa xong (/ctx reindex)')
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
    const now = await $.clock.now()
    if (now - cur.startedAt > INDEX_MAX_MS) {
      stopPolling()
      await setIndex($, { timedOut: true })
      await refreshStatus($)
      return
    }
    const res = await api($, 'GET', `/api/repos/${repoId(norm)}/status`)
    if (!res.ok) return
    const s = parse(res.body)
    const state = text(s.state)
    const phase = text(s.phase) || 'idle'
    const indexed = typeof s.indexed_files === 'number' ? s.indexed_files : cur.indexed
    const total = typeof s.total_files === 'number' ? s.total_files : cur.total
    const ticks = cur.ticks + 1
    const sawBusy = cur.sawBusy || (state !== '' && state !== 'error' && !IDLE_STATES.has(state))
    // A first run that never shows a busy state is given longer before it counts as empty.
    const grace = cur.first ? FIRST_GRACE_TICKS : IDLE_GRACE_TICKS
    const settled = IDLE_STATES.has(state) && (sawBusy || text(s.last_indexed_at) !== cur.baseline || ticks >= grace)

    // ETA from the rate between the first progress sample and this one.
    let { sampleAt, sampleDone } = cur
    // A poll with no new progress keeps the last ETA rather than dropping it.
    let etaMs = cur.etaMs
    if (!(state === 'indexing' && phase === 'embedding' && total > 0)) etaMs = -1
    else {
      if (sampleAt === 0) {
        sampleAt = now
        sampleDone = indexed
      } else if (indexed > sampleDone && now > sampleAt) {
        etaMs = ((total - indexed) * (now - sampleAt)) / (indexed - sampleDone)
      }
    }
    const failed = state === 'error'
    await setIndex($, {
      state, phase, phaseDone: num(s.phase_done), phaseTotal: num(s.phase_total), indexed, total,
      error: failed ? text(s.error) || 'error' : '', sawBusy, ticks, done: settled, sampleAt, sampleDone, etaMs,
    })
    await refreshStatus($)
    if (settled || failed) stopPolling()
    // Only a first run is worth a toast; later runs finish quietly.
    if (settled && cur.first && indexed > 0) $.ui.toast(`✓ viber-context: đã lập chỉ mục ${vn(indexed)} file trong ${duration(now - cur.startedAt)}`)
  } catch {
    // A failed poll is retried on the next tick.
  }
}

// One incremental index run for the root, then a status poll every 3 s. A repo
// with no last_indexed_at or no files has never been indexed: its run is the
// first one, which shows progress and ends in a toast.
async function startIndex($: EngineInterface, norm: string): Promise<boolean> {
  const id = repoId(norm)
  const before = parse((await api($, 'GET', `/api/repos/${id}/status`)).body)
  const first = text(before.last_indexed_at) === '' || num(before.indexed_files) === 0
  const started = await api($, 'POST', `/api/repos/${id}/index`)
  if (!started.ok) {
    await setFault($, 'ctx ✗ không lập chỉ mục được')
    return false
  }
  const now = await $.clock.now()
  await update($, indexAtom, () => ({ ...NO_INDEX, baseline: text(before.last_indexed_at), first, startedAt: now }))
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
    stopPolling()
    await update($, indexAtom, () => NO_INDEX)
    await setFault($, '')
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

// Throwaway directories (Claude Desktop scratch workspace, OS temp dir) hold no project.
async function isScratch($: EngineInterface, norm: string): Promise<boolean> {
  const values = [await $.env.get('TEMP'), await $.env.get('TMP'), await $.env.get('TMPDIR')]
  const temps = values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => normalizeRepo(v.trim()))
  return isScratchPath(norm, temps)
}

const disabledKey =(norm: string): string => `disabled:${norm}`

const reply = (body: string) => ({ result: body, text: body })

const fallback = (why: string): string =>
  `Không truy xuất được codebase qua context engine (${why}). Hãy dùng Grep/Glob/Read để tìm code thay thế.`

// What a call came to: the text Claude reads, and for the card why it has no results.
type Outcome = { text: string; skipped: Card['skipped']; note: string }
const ok = (body: string): Outcome => ({ text: body, skipped: '', note: '' })
const unavailable = (body: string, skipped: Card['skipped'], note: string): Outcome => ({ text: body, skipped, note })

// The shared body of both tools: gate on mode and plan, post to the engine, relay `result`.
async function retrieve($: EngineInterface, path: string, payload: Fields): Promise<Outcome> {
  const mode = await read($, modeAtom)
  if (mode === 'skipped') return unavailable(fallback('thư mục này là thư mục home, gốc ổ đĩa hoặc thư mục tạm nên không được lập chỉ mục'), 'off', 'Not available in this directory. Use Grep / Read instead.')
  if (mode === 'off') return unavailable('Truy xuất codebase đang tắt cho dự án này (/ctx on để bật lại). Hãy dùng Grep/Glob/Read.', 'off', 'Retrieval is off for this project (/ctx on). Use Grep / Read instead.')
  const level = planLevel(await read($, planAtom), await $.clock.now())
  if (level === 'expired') return { text: fallback('gói dịch vụ của context engine đã hết hạn, không gọi engine'), skipped: 'expired', note: '' }
  if (level === 'out') return { text: fallback('đã hết lượt search của gói dịch vụ, không gọi engine'), skipped: 'quota', note: '' }
  const root = await read($, rootAtom)
  const res = await api($, 'POST', path, { ...payload, workspace_full_path: root })
  if (res.status === 0) return unavailable(fallback('engine chưa chạy'), 'failed', 'Engine unavailable. Use Grep / Read instead.')
  // The engine answered, so a search was spent (or refused): refresh the numbers.
  detach(refreshPlan($))
  if (!res.ok) return unavailable(fallback(`engine trả HTTP ${res.status}: ${res.body.slice(0, 300)}`), 'failed', `Engine error (HTTP ${res.status}). Use Grep / Read instead.`)
  const out = parse(res.body).result
  return ok(typeof out === 'string' ? out : res.body)
}

// Keeps what the transcript card draws for this call; the newest MAX_CARDS stay.
async function recordCard($: EngineInterface, id: string, startedAt: number, out: Outcome): Promise<void> {
  const parsed = out.skipped === '' ? parseRetrieval(out.text) : { chunks: 0, rows: [] }
  const card: Card = { ms: Math.max(0, (await $.clock.now()) - startedAt), chunks: parsed.chunks, rows: parsed.rows, skipped: out.skipped, note: out.note }
  await update($, cardsAtom, all => {
    const next = { ...all, [id]: card }
    const ids = Object.keys(next)
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_CARDS))) delete next[old]
    return next
  })
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
  lines.push(`Tự lập chỉ mục: ${mode === 'on' ? 'bật' : mode === 'off' ? 'tắt (/ctx on để bật)' : 'bỏ qua (thư mục home, gốc ổ đĩa hoặc thư mục tạm)'}`)
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

// ---------------------------------------------------------------------------
// The retrieval card. A terminal Box paints no background, so every row is one
// Text whose background runs the full width; the top and bottom edges are
// quadrant blocks, giving half a row of padding and corners cut by half a cell.

type TextEl = ElementConstructor<TextProps>
type BoxEl = ElementConstructor<BoxProps>
type Seg = { text: string; color?: string; bold?: boolean }

const C = {
  card: '#27282B',
  running: '#1B2A40',
  text: '#E0E1E4',
  soft: '#C3C5C9',
  dim: '#909192',
  faint: '#696A6B',
  path: '#71A3EF',
  icon: '#AF9CFF',
  ok: '#69B090',
  run: '#4B8DEC',
  error: '#F87C88',
  warn: '#E5BF8C',
}
const CARD_ROWS = 4

const cells = (s: string): number => [...s].length
const segCells = (segs: Seg[]): number => segs.reduce((n, s) => n + cells(s.text), 0)

// Cuts a run of segments to `max` cells, ending in an ellipsis.
function fitSegs(segs: Seg[], max: number): Seg[] {
  if (segCells(segs) <= max) return segs
  const out: Seg[] = []
  let room = max - 1
  for (const s of segs) {
    if (room <= 0) break
    const taken = [...s.text].slice(0, room).join('')
    out.push({ ...s, text: taken })
    room -= cells(taken)
  }
  out.push({ text: '…', color: C.dim })
  return out
}

const cardWidth = (columns: number | undefined): number => Math.max(40, Math.min((columns ?? 100) - 4, 120))

function paint(Text: TextEl, bg: string, width: number, segs: Seg[]): RenderElement {
  const used = 1 + segCells(segs)
  return (
    <Text backgroundColor={bg}>
      {' '}
      {segs.map(s => (
        <Text color={s.color} bold={s.bold} backgroundColor={bg}>{s.text}</Text>
      ))}
      {' '.repeat(Math.max(0, width - used))}
    </Text>
  )
}

// `left` at the start of the row and `right` flush to its end.
function split(Text: TextEl, bg: string, width: number, left: Seg[], right: Seg[]): RenderElement {
  const rightCells = segCells(right)
  const room = width - 2 - (rightCells > 0 ? rightCells + 2 : 0)
  const shown = fitSegs(left, Math.max(8, room))
  const gap = Math.max(2, width - 2 - segCells(shown) - rightCells)
  return paint(Text, bg, width, rightCells > 0 ? [...shown, { text: ' '.repeat(gap) }, ...right] : shown)
}

// The line under a card header saying why a call has no results.
const reasonOf = (card: Card): string =>
  card.skipped === 'quota' ? 'Search quota used up. Use Grep / Read instead; renew the plan at 127.0.0.1:6699.'
  : card.skipped === 'expired' ? 'Plan expired. Use Grep / Read instead; renew the plan at 127.0.0.1:6699.'
  : card.note

async function retrievalCard($: EngineInterface, e: { props: { tool_use_id: string; input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean }; viewport?: { columns?: number } }, label: string, Box: BoxEl, Text: TextEl): Promise<RenderElement> {
  const props = e.props
  const [cards, plan, root, now] = await Promise.all([read($, cardsAtom), read($, planAtom), read($, rootAtom), $.clock.now()])
  const card = cards[props.tool_use_id]
  const width = cardWidth(e.viewport?.columns)
  const bg = props.isRunning ? C.running : C.card
  const bad = props.isErrored || props.isInterrupted || (card !== undefined && card.skipped !== '')
  // A finished call with no record (a resumed session, a call this plugin never saw) is neither a success nor a failure.
  const status: Seg = props.isRunning ? { text: '◌', color: C.run }
    : bad ? { text: '✗', color: C.error }
    : card === undefined ? { text: '•', color: C.dim }
    : { text: '✓', color: C.ok }
  const request = text(fields(props.input).information_request).replace(/\s+/g, ' ').trim()
  const right: Seg[] =
    card === undefined || props.isRunning ? []
    : card.skipped === 'failed' ? [{ text: 'failed', color: C.dim }]
    : card.skipped !== '' ? [{ text: 'skipped', color: C.dim }]
    : [{ text: `${card.chunks} ${card.chunks === 1 ? 'chunk' : 'chunks'} · ${(card.ms / 1000).toFixed(1)}s`, color: C.dim }]

  const rows: RenderElement[] = [
    split(Text, bg, width, [status, { text: ' ' }, { text: '◎', color: C.icon }, { text: ' ' }, { text: label, color: C.dim }, { text: '  ' }, { text: request, color: C.text }], right),
  ]
  if (card !== undefined && !props.isRunning) {
    if (card.skipped !== '') {
      rows.push(paint(Text, bg, width, fitSegs([{ text: '  ' }, { text: reasonOf(card), color: C.soft }], width - 2)))
    }
    for (const row of card.rows.slice(0, CARD_ROWS)) {
      // The code line gives way first: the path and the caller/callee tags stay whole.
      const head: Seg[] = [{ text: '  ' }, { text: shortPath(root, row.path), color: C.path }, { text: `#L${row.start}-${row.end}`, color: C.faint }]
      const tail: Seg[] = [
        ...(row.callers === '' ? [] : [{ text: '  ' }, { text: `← ${row.callers}`, color: C.faint }]),
        ...(row.calls === '' ? [] : [{ text: '  ' }, { text: `→ ${row.calls}`, color: C.faint }]),
      ]
      const room = width - 2 - segCells(head) - segCells(tail) - 2
      const code: Seg[] = row.symbol === '' || room < 8 ? [] : [{ text: '  ' }, ...fitSegs([{ text: row.symbol, color: C.soft }], room)]
      rows.push(paint(Text, bg, width, fitSegs([...head, ...code, ...tail], width - 2)))
    }
    if (card.rows.length > CARD_ROWS) {
      rows.push(paint(Text, bg, width, [{ text: `  +${card.rows.length - CARD_ROWS} more`, color: C.faint }]))
    }
  }
  if (plan.known && !props.isRunning) {
    const level = planLevel(plan, now)
    const left = `${en(plan.searchLeft)} searches left`
    const note: Seg = level === 'ok' ? { text: left, color: C.dim } : { text: `⚠ ${left}`, color: C.warn }
    rows.push(split(Text, bg, width, [], [note]))
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={bg}>{`▗${'▄'.repeat(Math.max(0, width - 2))}▖`}</Text>
      {rows}
      <Text color={bg}>{`▝${'▀'.repeat(Math.max(0, width - 2))}▘`}</Text>
    </Box>
  )
}

const CARD_LABEL: Record<string, string> = { [RETRIEVAL_ID]: 'Retrieval', [FILE_RETRIEVAL_ID]: 'File retrieval' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Decided before the tools register: their placement (tool.describe) reads the mode.
    const cwd = await $.session.cwd()
    const root = await projectRoot($, cwd)
    const norm = normalizeRepo(root)
    await update($, rootAtom, () => root)
    const skipped = isFilesystemRoot(norm) || (await isHome($, norm)) || (await isScratch($, norm))
    const disabled = !skipped && (await $.store.get(disabledKey(norm))) === true
    const mode: Mode = skipped ? 'skipped' : disabled ? 'off' : 'on'
    await update($, modeAtom, () => mode)
    await $.tool.register({
      name: RETRIEVAL,
      description: [
        'Call this FIRST for any question about this codebase (overview, architecture, how X works, where Y is). Semantic search over this project\'s indexed codebase (local context engine): describe what you need in natural language and it returns the most relevant code snippets with file paths and line ranges.',
        'Write one detailed request (what, where, why) instead of reading many files; for "analyze this project" ask e.g. "architecture overview: entry points, main modules, how a request flows", then Read the specific files it points to. Prefer it over ls/cat/Bash/Explore for discovering how the code works.',
        'Use Grep/Glob instead for exact identifiers, strings or file names. Avoid near-identical repeat queries.',
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

    if (mode === 'on') {
      // Booting can take a while (engine start); the session does not wait for it.
      detach(boot($, norm, isWindowsPath(root)))
    }
    return next(e)
  })

  // MCP tools sit behind ToolSearch by default and the model rarely loads them, so
  // retrieval would go unused: where it is enabled, put the schemas in the prompt's list.
  for (const id of [RETRIEVAL_ID, FILE_RETRIEVAL_ID]) {
    on('tool.describe', { tool: id }, async ($, e, next) => {
      const described = await next(e)
      return (await read($, modeAtom)) === 'on' ? { ...described, isDeferred: false } : described
    })
  }

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, modeAtom)) !== 'on') return composed
    const level = planLevel(await read($, planAtom), await $.clock.now())
    const body = level === 'out' || level === 'expired' ? PROMPT_SECTION_UNAVAILABLE : PROMPT_SECTION
    return { sections: [...composed.sections, { id: 'viber-context:retrieval', text: body, scope: 'session' as const }] }
  })

  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    if ((await read($, modeAtom)) !== 'on') return context
    const level = planLevel(await read($, planAtom), await $.clock.now())
    if (level === 'out' || level === 'expired') return context
    return { ...context, blocks: [...context.blocks.filter(b => b.name !== CONTEXT_BLOCK_NAME), { name: CONTEXT_BLOCK_NAME, text: CONTEXT_BLOCK }] }
  })

  // The tools are already in the tool list; the engine's deferred-tools reminder would say they need loading.
  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, e, next) => {
    const attached = await next(e)
    if ((await read($, modeAtom)) !== 'on' || attached.text === null) return attached
    return { ...attached, text: stripToolNames(attached.text, [RETRIEVAL_ID, FILE_RETRIEVAL_ID]) }
  })

  on('tool.call', { tool: RETRIEVAL_ID }, async ($, e) => {
    const input = fields(e)
    const startedAt = await $.clock.now()
    if (text(input.information_request).trim() === '') {
      const out = unavailable('Thiếu information_request. Hãy mô tả chi tiết thứ cần tìm.', 'failed', 'Missing information_request.')
      await recordCard($, e.tool_use_id, startedAt, out)
      return reply(out.text)
    }
    const out = await retrieve($, '/api/mcp-tool', { information_request: withFilters(input) })
    await recordCard($, e.tool_use_id, startedAt, out)
    return reply(out.text)
  })

  on('tool.call', { tool: FILE_RETRIEVAL_ID }, async ($, e) => {
    const input = fields(e)
    const startedAt = await $.clock.now()
    if (text(input.file_path).trim() === '' || text(input.information_request).trim() === '') {
      const out = unavailable('Thiếu file_path hoặc information_request.', 'failed', 'Missing file_path or information_request.')
      await recordCard($, e.tool_use_id, startedAt, out)
      return reply(out.text)
    }
    const top = typeof input.top_k === 'number' && Number.isFinite(input.top_k) ? { top_k: Math.max(1, Math.round(input.top_k)) } : {}
    const out = await retrieve($, '/api/mcp-tool/file-retrieval', {
      file_path: text(input.file_path).trim(),
      information_request: text(input.information_request).trim(),
      ...top,
    })
    await recordCard($, e.tool_use_id, startedAt, out)
    return reply(out.text)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const root = await read($, rootAtom)
    const norm = normalizeRepo(root)
    const mode = await read($, modeAtom)
    if (arg === 'off' || arg === 'on') {
      if (mode === 'skipped') return { text: 'Thư mục này là thư mục home, gốc ổ đĩa hoặc thư mục tạm, không được lập chỉ mục.' }
      await $.store.set(disabledKey(norm), arg === 'off')
      await update($, modeAtom, () => (arg === 'off' ? 'off' : 'on'))
      // The placement answer is cached for the session.
      $.ui.invalidate('tool.describe')
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

  // The card replaces the raw result row; the model still reads the full text.
  on('ui.render', { component: 'ToolUse', surface: 'terminal' }, async ($, e, next) => {
    const label = CARD_LABEL[e.props.tool]
    if (label === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return retrievalCard($, e, label, Box, Text)
  })

  // Hidden only where a card record exists to stand in for it; a call from before
  // this session's records (a resumed transcript) keeps its default result row.
  on('ui.render', { component: 'ToolResult', surface: 'terminal' }, async ($, e, next) => {
    if (e.props.isErrored || CARD_LABEL[e.props.tool] === undefined) return next(e)
    if ((await read($, cardsAtom))[e.props.tool_use_id] === undefined) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // A folded run of reads and searches would hide a retrieval call inside a count
  // line, with no card. Unfolding it makes every call its own ToolUse row, so the
  // card hook above draws the retrieval ones and the other hooks draw the rest;
  // a group without a retrieval call is left to whoever draws it.
  on('ui.render', { component: 'ToolGroup', surface: 'terminal' }, ($, e, next) => {
    if (e.props.isExpanded || !e.props.calls.some(call => CARD_LABEL[call.tool] !== undefined)) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

}
