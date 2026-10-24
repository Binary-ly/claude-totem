export type TotemState = 'idle' | 'working' | 'needs' | 'done'

export type TotemSource = 'team' | 'user' | 'auto'

/** What a project looks like everywhere totem draws it. */
export type TotemIdentity = {
  /** The project's root: the main working tree's for a worktree. */
  key: string
  name: string
  emoji: string
  /** OKLCH hue angle, 0 to 359. */
  hue: number
  /** 0 to 1: how much color the palette carries (0 is neutral gray). */
  chroma: number
  source: TotemSource
}

/** One live session as the radar sees it. */
export type TotemPeer = {
  id: string
  key: string
  name: string
  emoji: string
  hue: number
  chroma: number
  tty: string | null
  /** TERM_PROGRAM, or the multiplexer's name. */
  program: string
  /** A pane id the program can focus by: WEZTERM_PANE, KITTY_WINDOW_ID, TMUX_PANE. */
  pane: string | null
  state: TotemState
  since: number
  seenAt: number
  cwd: string
  branch: string | null
}

export type TotemView = {
  identity: TotemIdentity | null
  isForging: boolean
  isLight: boolean
  path: string
  branch: string | null
  isWorktree: boolean
  /** The arrival reveal has played for this identity. */
  hasArrived: boolean
}

declare module 'claude-code' {
  interface PluginState {
    totem: {
      view: Shaped<TotemView>
      status: Shaped<{ state: TotemState; since: number }>
      peers: Shaped<TotemPeer[]>
    }
  }
}
