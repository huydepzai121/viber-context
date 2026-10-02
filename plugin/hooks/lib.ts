// Pure helpers: no host calls, so they are safe to share and to test.

import type { PlanInfo } from '../types'

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

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

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
  'This project is indexed by a local context engine. Use `mcp__viber-context__codebase_retrieval` to find code by meaning.',
  '- When a task needs understanding of code that is not yet in your context, call codebase_retrieval first with a detailed natural-language request (what you are looking for, where it likely lives, why you need it) instead of reading many files one by one.',
  '- One well-formed request beats several narrow ones. Put the whole question in one request.',
  '- Use Grep/Glob for exact identifiers, strings or file names. Use `mcp__viber-context__file_retrieval` when you already know the file but not the lines.',
  '- Skip retrieval for questions that do not need the codebase (general knowledge, small edits to code already in context).',
  '- Searches are a limited paid quota: avoid repeated near-identical queries and do not search speculatively.',
].join('\n')

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
