// Pure helpers: no host calls, so they are safe to share and to test.

import type { CardRow, IndexInfo, PlanInfo } from '../types'

export const ENGINE = 'http://127.0.0.1:6699'
export const ENGINE_PORT = 6699

// The engine's own path normalization (`normalize_repo_path`): on Windows
// `/` becomes `\`, lowercase, no trailing slash; elsewhere `\` becomes `/`.
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.includes('\\')
}

export function normalizeRepo(p: string): string {
  if (isWindowsPath(p)) return p.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

// A filesystem or drive root: `/`, `C:\`, `E:`.
export function isFilesystemRoot(p: string): boolean {
  return p === '' || /^[A-Za-z]:[\\/]*$/.test(p) || /^[\\/]+$/.test(p)
}

// A throwaway directory that holds no project: a Claude Desktop "No folder"
// scratch workspace (`...\Claude\scratch-workspaces\...`, either slash style)
// or the OS temp directory itself or anything inside it. `p` and `tempDirs`
// are normalizeRepo output; empty temp entries and drive roots are ignored so
// a bad TMPDIR cannot make every directory look temporary.
export function isScratchPath(p: string, tempDirs: readonly string[]): boolean {
  const flat = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const path = flat(p)
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i++) {
    if (segments[i] === 'scratch-workspaces' && segments[i - 1] === 'claude') return true
  }
  return tempDirs.some(t => {
    if (t === '' || isFilesystemRoot(t)) return false
    const temp = flat(t)
    return temp !== '' && (path === temp || path.startsWith(`${temp}/`))
  })
}

const B64 ='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

// base64url without padding, as the engine's repo id in URLs.
export function repoId(normalized: string): string {
  const bytes = utf8(normalized)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += B64[c & 63]
  }
  return out
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []

// `kind:function lang:typescript path:src/api <request>`: the engine reads the
// field filters off the front of the query text.
export function withFilters(input: Record<string, unknown>): string {
  const request = typeof input.information_request === 'string' ? input.information_request.trim() : ''
  const path = typeof input.filter_path === 'string' ? input.filter_path.trim() : ''
  const prefixes = [
    ...strings(input.filter_kind).map(k => `kind:${k}`),
    ...strings(input.filter_lang).map(l => `lang:${l}`),
    ...(path ? [`path:${path}`] : []),
  ]
  return [...prefixes, request].join(' ')
}

export const PROMPT_SECTION = [
  '# Codebase retrieval (local context engine)',
  'ALWAYS call `mcp__viber-context__codebase_retrieval` FIRST for any question about this codebase (overview, architecture, how X works, where Y is, analyze or review the project), before Bash, ls, cat, git diff, Glob or reading files. Use it instead of the Explore subagent. Put the whole question in one detailed natural-language request, e.g. "architecture overview: entry points, main modules, how requests flow". Then Read only the files it points to.',
  'Use `mcp__viber-context__file_retrieval` to find lines inside a file you already know. Use Grep/Glob only for exact identifiers, strings or file names.',
  'Do not repeat near-identical queries.',
].join('\n')

// Appended to the first user message as a project instruction: instructions in the
// user-message context (like CLAUDE.md) are followed far more reliably than a system section.
export const CONTEXT_BLOCK_NAME = 'viberContext'
export const CONTEXT_BLOCK = [
  'This project is indexed by a local context engine (viber-context).',
  'When asked about the codebase, project structure, how something works, or to analyze/review/explain this project, ALWAYS call mcp__viber-context__codebase_retrieval FIRST, before Bash, ls, cat, git diff, Glob or reading files. Use it instead of the Explore subagent. Then Read only the files it points to.',
  'Use mcp__viber-context__file_retrieval to find lines inside a known file. Use Grep/Glob only for exact identifiers or file names.',
].join('\n')

// The engine lists every MCP tool it keeps behind ToolSearch in a deferred_tools_delta
// reminder, one name per line. The retrieval tools are already in the tool list, so the
// reminder would wrongly say they must be loaded first: drop their lines, and a paragraph
// left with only its heading, and nothing at all when no name remains.
export function stripToolNames(text: string, names: readonly string[]): string | null {
  const drop = new Set(names)
  const kept: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const lines = paragraph.split('\n')
    const rest = lines.filter(line => !drop.has(line.trim()))
    if (rest.length === lines.length) kept.push(paragraph)
    else if (rest.length > 1 || (rest.length === 1 && !rest[0].trim().endsWith(':'))) kept.push(rest.join('\n'))
  }
  return kept.length === 0 ? null : kept.join('\n\n')
}

export const PROMPT_SECTION_UNAVAILABLE = [
  '# Codebase retrieval (local context engine)',
  'The local context engine\'s search quota or plan is exhausted for this session, so `mcp__viber-context__codebase_retrieval` and `mcp__viber-context__file_retrieval` are unavailable and only return an error. Do not call them; explore with Grep, Glob and Read.',
].join('\n')

// 1234567 -> "1.234.567" (vi-VN grouping, without depending on the host's ICU).
export const vn = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const DAY_MS = 86_400_000

export type PlanFacts = { known: boolean; expiresAt: number; searchLeft: number; searchLimit: number }
export type PlanLevel = 'ok' | 'warn' | 'out' | 'expired'

export const daysLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))

// expired: past the expiry; out: no searches left; warn: <= 5% of the limit or
// <= 50 searches left, or <= 3 days left. A plan whose usage is unknown is ok.
export function planLevel(plan: PlanFacts, now: number): PlanLevel {
  if (!plan.known) return 'ok'
  if (plan.expiresAt > 0 && now > plan.expiresAt) return 'expired'
  if (plan.searchLeft <= 0) return 'out'
  const low = plan.searchLeft <= 50 || plan.searchLeft <= plan.searchLimit * 0.05
  const soon = plan.expiresAt > 0 && daysLeft(plan.expiresAt, now) <= 3
  return low || soon ? 'warn' : 'ok'
}

// DD/MM/YYYY of a UTC instant.
export function dayString(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// A 20-cell bar in eighth blocks, filled by `left` of `limit`.
export function bar(left: number, limit: number, cells = 20): string {
  const share = limit > 0 ? Math.min(1, Math.max(0, left / limit)) : 0
  const eighths = Math.round(share * cells * 8)
  const whole = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  return '█'.repeat(whole) + part + '░'.repeat(cells - whole - (part ? 1 : 0))
}

const pad = (t: string, w: number): string => t + ' '.repeat(Math.max(0, w - [...t].length))

// The "Gói dịch vụ" block of /ctx: package, expiry, two bars. No key, no invoice.
export function planBlock(plan: PlanInfo, now: number): string {
  if (!plan.known) return 'Gói dịch vụ: không đọc được mức sử dụng (engine chưa chạy hoặc billing không trả lời).'
  const level = planLevel(plan, now)
  const left = daysLeft(plan.expiresAt, now)
  const lines = [
    `Gói dịch vụ: ${plan.name || '(không tên)'}${plan.expiresAt > 0 ? ` · hết hạn ${dayString(plan.expiresAt)} (${level === 'expired' ? 'đã hết hạn' : `còn ${left} ngày`})` : ''}`,
    `${pad('Embeddings', 11)}${bar(plan.embedLeft, plan.embedLimit)} ${vn(plan.embedLeft)} / ${vn(plan.embedLimit)}`,
    `${pad('Search', 11)}${bar(plan.searchLeft, plan.searchLimit)} ${vn(plan.searchLeft)} / ${vn(plan.searchLimit)}`,
  ]
  if (level === 'expired') lines.push(`Gói đã hết hạn: gia hạn hoặc mua gói mới trong giao diện web của engine ${ENGINE}.`)
  else if (level === 'out') lines.push(`Đã hết lượt search: mua thêm hoặc gia hạn trong giao diện web của engine ${ENGINE}.`)
  else if (level === 'warn') lines.push(`Sắp hết gói: gia hạn hoặc mua thêm trong giao diện web của engine ${ENGINE}.`)
  return lines.join('\n')
}

export const NO_INDEX: IndexInfo = {
  state: '', phase: '', phaseDone: 0, phaseTotal: 0, indexed: 0, total: 0, done: false, timedOut: false, error: '',
  baseline: '', first: false, sawBusy: false, ticks: 0, startedAt: 0, sampleAt: 0, sampleDone: 0, etaMs: -1,
}

// 125 s -> "2m 5s", 45 s -> "45s", 3900 s -> "1h 5m". At least one second.
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 === 0 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`
  const m = Math.floor((s % 3600) / 60)
  return m === 0 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)}h ${m}m`
}

export const eta = (ms: number): string => `~${duration(ms)}`

export function meter(ratio: number, cells = 10): string {
  const on = Math.max(0, Math.min(cells, Math.round(ratio * cells)))
  return '▰'.repeat(on) + '▱'.repeat(cells - on)
}

// The line for an index run that is not finished. The engine's phase values:
// idle (no stage yet), embedding (indexed_files / total_files), symbol_index,
// resolve_edges. While embedding, total_files is the run's workset: every file
// of a first run, only the changed ones of a later run; 0 until the scan ends.
export function progressLine(i: IndexInfo): string {
  if (i.startedAt === 0) return 'ctx ◌ đang bật engine…'
  const busy = i.state === 'indexing'
  if (busy && i.phase === 'resolve_edges') return 'ctx ◌ nối quan hệ gọi hàm…'
  if (busy && i.phase !== 'embedding' && i.phase !== 'idle') return 'ctx ◌ lập chỉ mục…'
  const counted = busy && i.phase === 'embedding' && i.total > 0
  if (!i.first) return counted ? `ctx ◌ cập nhật ${vn(i.total)} file đã đổi…` : 'ctx ◌ kiểm tra thay đổi…'
  if (!counted) return 'ctx ◌ lần đầu lập chỉ mục · đang quét file…'
  const ratio = Math.min(1, i.indexed / i.total)
  return `ctx ◌ lập chỉ mục ${meter(ratio)} ${Math.round(ratio * 100)}% · ${vn(i.indexed)}/${vn(i.total)} file${i.etaMs >= 0 ? ` · còn ${eta(i.etaMs)}` : ''}`
}

// 1234567 -> "1,234,567".
export const en = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export type Retrieval = { chunks: number; rows: CardRow[] }

const HEADER = /^(\S.*?)#L(\d+)-(\d+)((?: \[(?:callers|calls):[^\]]*\])*)\s*$/
const TAG = (name: string) => new RegExp(`\\[${name}:\\s*([^\\]]*)\\]`)

// Reads the engine's formatted result: blocks of `path#Lstart-end [callers: a,
// b +N more] [calls: x]` followed by numbered code lines (`12: code`), blocks
// separated by a blank line. Anything else (an empty-result message, the
// truncation footer) yields no block.
export function parseRetrieval(result: string): Retrieval {
  const lines = result.split(/\r?\n/)
  const rows: CardRow[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^\d+: /.test(line)) continue
    const m = HEADER.exec(line)
    if (!m) continue
    const tags = m[4] ?? ''
    const code = (lines[i + 1] ?? '').match(/^\d+: (.*)$/)
    rows.push({
      path: m[1] ?? '',
      start: Number(m[2]),
      end: Number(m[3]),
      symbol: (code?.[1] ?? '').trim(),
      callers: (TAG('callers').exec(tags)?.[1] ?? '').trim(),
      calls: (TAG('calls').exec(tags)?.[1] ?? '').trim(),
    })
  }
  return { chunks: rows.length, rows }
}

// The path relative to the project root when it lies under it, with `/`.
export function shortPath(root: string, path: string): string {
  const flat = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base !== '' && flat.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return flat.slice(base.length + 1)
  return flat
}
