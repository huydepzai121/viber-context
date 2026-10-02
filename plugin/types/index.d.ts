// Whether retrieval is wired up for the session's project root: 'on' it is,
// 'off' the person turned it off (/ctx off), 'skipped' the root is a home or
// filesystem root and is never indexed.
export type Mode = 'on' | 'off' | 'skipped'

// One index run as the status poll sees it. `baseline` is the engine's
// last_indexed_at before the run started; `sawBusy` and `ticks` tell a run that
// finished from one that has not begun.
export type IndexInfo = {
  state: string
  indexed: number
  total: number
  done: boolean
  error: string
  baseline: string
  sawBusy: boolean
  ticks: number
  startedAt: number
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
    }
  }
}
