// Whether retrieval is wired up for the session's project root: 'on' it is,
// 'off' the person turned it off (/ctx off), 'skipped' the root is a home or
// filesystem root and is never indexed.
export type Mode = 'on' | 'off' | 'skipped'

// One index run as the status poll sees it. `baseline` is the engine's
// last_indexed_at before the run started; `first` is true when the repo had
// never been indexed. `phase` is the engine's own value (idle, embedding,
// symbol_index, resolve_edges); `sawBusy` and `ticks` tell a run that finished
// from one that has not begun; `sampleAt`/`sampleDone` are the first progress
// sample the ETA is measured from, `etaMs` is -1 until there is a second one.
export type IndexInfo = {
  state: string
  phase: string
  phaseDone: number
  phaseTotal: number
  indexed: number
  total: number
  done: boolean
  timedOut: boolean
  error: string
  baseline: string
  first: boolean
  sawBusy: boolean
  ticks: number
  startedAt: number
  sampleAt: number
  sampleDone: number
  etaMs: number
}

// One result block of a retrieval, parsed from the engine's text.
export type CardRow = {
  path: string
  start: number
  end: number
  // The first code line of the block.
  symbol: string
  callers: string
  calls: string
}

// What the transcript card draws for one retrieval call. `skipped` is set when
// the call did not produce results: 'quota' and 'expired' by the plan, 'off' by
// /ctx off or an unindexed directory (all skipped without calling the engine),
// 'failed' when the call was malformed or the engine could not answer. `note` is
// the reason line the card shows for 'off' and 'failed'.
export type Card = {
  ms: number
  chunks: number
  rows: CardRow[]
  skipped: '' | 'quota' | 'expired' | 'off' | 'failed'
  note: string
}

// The active plan as the usage endpoint reports it. Never holds a key or invoice.
// `known` is false when the usage could not be read.
export type PlanInfo = {
  known: boolean
  name: string
  // Plan expiry, ms since epoch (UTC); 0 when unknown.
  expiresAt: number
  searchLeft: number
  searchLimit: number
  embedLeft: number
  embedLimit: number
}

declare module 'claude-code' {
  interface PluginState {
    'viber-context': {
      // The project root: git's top level, else the cwd.
      root: string
      mode: Mode
      engine: 'unknown' | 'up' | 'down'
      index: IndexInfo
      // A status line that replaces the index and plan parts while set (engine down, ...).
      fault: string
      plan: PlanInfo
      // Worst plan state already toasted this session: 0 none, 1 warn, 2 out or expired.
      alerted: number
      // Newest retrieval cards by tool_use_id, capped.
      cards: Record<string, Card>
    }
  }
}
