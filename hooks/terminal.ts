// The terminal around the session: found by its tty and spoken to with
// escape sequences written straight to that device, so it works the same
// under the hooks host as from a shell. Nothing here prints to the screen.

import type { EngineInterface } from 'claude-code'

import { hex, type Rgb } from './color'

type $ = EngineInterface

const ESC = '\u001b'
const BEL = '\u0007'

export const osc = {
  background: (rgb: Rgb) => `${ESC}]11;${hex(rgb)}${BEL}`,
  resetBackground: () => `${ESC}]111${BEL}`,
  title: (text: string) => `${ESC}]0;${clean(text)}${BEL}`,
}

/** Control characters out, so a folder name can never smuggle a sequence. */
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// Walks up from the shell's parent (the CLI) to the first process holding a
// terminal, since the hooks host may run detached from it.
const FIND_TTY = [
  'p=$PPID',
  'while [ "${p:-1}" -gt 1 ]; do',
  '  t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d " ")',
  '  case "$t" in',
  '    ""|"?"|"??") p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ") ;;',
  '    *) [ -w "/dev/$t" ] && echo "/dev/$t" && exit 0; exit 1 ;;',
  '  esac',
  'done',
  'exit 1',
].join('\n')

export async function findTty($: $): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['sh', '-c', FIND_TTY], {
      timeoutMs: 5000,
    })
    const tty = stdout.trim()

    return exitCode === 0 && tty.startsWith('/dev/') ? tty : null
  } catch {
    return null
  }
}

export async function write($: $, tty: string, sequence: string): Promise<void> {
  try {
    await $.process.run(['sh', '-c', 'printf "%s" "$2" > "$1"', 'sh', tty, sequence], {
      timeoutMs: 5000,
    })
  } catch {
    // A terminal that went away takes its tint with it.
  }
}

/** Writes each sequence in turn, `stepMs` apart, in one child process. */
export async function play(
  $: $,
  tty: string,
  sequences: readonly string[],
  stepMs: number,
): Promise<void> {
  if (sequences.length === 0) return
  const script =
    'tty=$1; d=$2; shift 2; for s in "$@"; do printf "%s" "$s" > "$tty"; sleep "$d"; done'
  try {
    await $.process.run(
      ['sh', '-c', script, 'sh', tty, (stepMs / 1000).toFixed(3), ...sequences],
      { timeoutMs: 15000 },
    )
  } catch {
    // As in `write`.
  }
}

export type Program = {
  /** TERM_PROGRAM as the terminal set it, or the multiplexer's name. */
  name: string
  /** The pane id the program focuses by, where it has one. */
  pane: string | null
}

export async function detectProgram($: $): Promise<Program> {
  const tmux = await $.env.get('TMUX_PANE')
  if (tmux) return { name: 'tmux', pane: tmux }
  const wezterm = await $.env.get('WEZTERM_PANE')
  if (wezterm) return { name: 'WezTerm', pane: wezterm }
  const kitty = await $.env.get('KITTY_WINDOW_ID')
  if (kitty) return { name: 'kitty', pane: kitty }

  return { name: (await $.env.get('TERM_PROGRAM')) ?? 'unknown', pane: null }
}

// Terminal.app's tabs carry their tty, so a tab is found by the device the
// session writes to. Run with the tty as the script's one argument.
const TERMINAL_APP_TAB = (body: string) => [
  'on run argv',
  '  set target to item 1 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is target then',
  body,
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "missing"',
  'end run',
]

const ITERM_SESSION = (body: string) => [
  'on run argv',
  '  set target to item 1 of argv',
  '  tell application "iTerm2"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        repeat with s in sessions of t',
  '          if tty of s is target then',
  body,
  '          end if',
  '        end repeat',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "missing"',
  'end run',
]

const osascript = (lines: readonly string[], ...args: string[]) => [
  'osascript',
  ...lines.flatMap(line => ['-e', line]),
  ...args,
]

/**
 * The tab's background as Terminal.app holds it, so a fade starts from the
 * color the person actually sees. Null anywhere else.
 */
export async function readBackground($: $, program: Program, tty: string): Promise<Rgb | null> {
  if (program.name !== 'Apple_Terminal') return null
  try {
    const lines = TERMINAL_APP_TAB('          return background color of t')
    const { exitCode, stdout } = await $.process.run(osascript(lines, tty), { timeoutMs: 4000 })
    const parts = stdout.split(',').map(v => Number(v.trim()))
    if (exitCode !== 0 || parts.length < 3 || parts.some(v => !Number.isFinite(v))) return null
    const [r = 0, g = 0, b = 0] = parts.map(v => Math.round(v / 257))

    return { r, g, b }
  } catch {
    return null
  }
}

/** Brings another session's tab to the front. True when it got there. */
export async function focus(
  $: $,
  target: { program: string; tty: string | null; pane: string | null },
): Promise<boolean> {
  const run = async (argv: string[]) => {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 5000 })
      return exitCode === 0 && !stdout.includes('missing')
    } catch {
      return false
    }
  }
  const { program, tty, pane } = target

  if (program === 'Apple_Terminal' && tty) {
    const body = [
      '          set selected of t to true',
      '          set index of w to 1',
      '          activate',
      '          return "ok"',
    ].join('\n')
    return run(osascript(TERMINAL_APP_TAB(body), tty))
  }
  if (program === 'iTerm.app' && tty) {
    const body = [
      '            select w',
      '            tell t to select',
      '            tell s to select',
      '            activate',
      '            return "ok"',
    ].join('\n')
    return run(osascript(ITERM_SESSION(body), tty))
  }
  if (program === 'tmux' && pane) {
    return run(['tmux', 'switch-client', '-t', pane])
  }
  if (program === 'WezTerm' && pane) {
    return run(['wezterm', 'cli', 'activate-pane', '--pane-id', pane])
  }
  if (program === 'kitty' && pane) {
    return run(['kitty', '@', 'focus-window', '--match', `id:${pane}`])
  }

  return false
}

/**
 * Whether Terminal.app's profile adds the process and its arguments to every
 * tab's title: the reason tabs read "…ode • claude --resume". Null when it
 * cannot tell (another terminal, or the settings could not be read).
 */
export async function terminalAppTabExtras(
  $: $,
  program: Program,
  tty: string | null,
): Promise<{ profile: string; process: boolean; args: boolean } | null> {
  if (program.name !== 'Apple_Terminal' || !tty) return null
  try {
    const lines = TERMINAL_APP_TAB('          return name of current settings of t')
    const named = await $.process.run(osascript(lines, tty), { timeoutMs: 4000 })
    const profile = named.stdout.trim()
    if (named.exitCode !== 0 || !profile || profile === 'missing') return null
    const home = await $.env.get('HOME')
    const plist = `${home}/Library/Preferences/com.apple.Terminal.plist`
    const flag = async (key: string) => {
      const { exitCode, stdout } = await $.process.run(
        ['plutil', '-extract', `Window Settings.${profile}.${key}`, 'raw', '-o', '-', plist],
        { timeoutMs: 4000 },
      )
      // Absent means Terminal's default, which shows both.
      return exitCode !== 0 || stdout.trim() !== 'false'
    }

    return {
      profile,
      process: await flag('ShowActiveProcessInTabTitle'),
      args: await flag('ShowActiveProcessArgumentsInTabTitle'),
    }
  } catch {
    return null
  }
}
