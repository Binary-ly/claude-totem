// totem: every session wears its project's identity. The terminal takes the
// project's color, the tab takes its name, the band above the prompt spells it
// in pixel letters, and a radar shows your other sessions, one press away.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { TotemIdentity, TotemPeer, TotemState, TotemView } from '../types'
import { chooseHue, hex, luminance, mix, oklch, palette, parseHex, toOklch, type Rgb } from './color'
import { Band, Forging, NAME_KEY, Pane, type Word } from './draw'
import { canDraw, frame, measure, rasterize, spell } from './font'
import { basename, forge, putSaved, recall, recentHues, settleEmoji } from './identity'
import { GLYPH, age, liveId, publish, retire, scan } from './radar'
import {
  detectProgram,
  findTty,
  focus,
  osc,
  play,
  readBackground,
  terminalAppTabExtras,
  write,
  type Program,
} from './terminal'

type $ = EngineInterface

type Options = {
  band: 'big' | 'bar' | 'off'
  tint: boolean
  title: boolean
  motion: 'full' | 'calm' | 'off'
  ai: boolean
  nudges: boolean
}

const settle = (o: PluginOptions): Options => ({
  band: o.band === 'bar' || o.band === 'off' ? o.band : 'big',
  tint: o.tint !== false,
  title: o.title !== false,
  motion: o.motion === 'calm' || o.motion === 'off' ? o.motion : 'full',
  ai: o.ai !== false,
  nudges: o.nudges !== false,
})

const EMPTY: TotemView = {
  identity: null,
  isForging: false,
  isLight: false,
  path: '',
  branch: null,
  isWorktree: false,
  hasArrived: false,
}

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const view = atom({ plugin: 'totem', key: 'view' } as const, EMPTY, { shape: 'view-1' })
const status = atom(
  { plugin: 'totem', key: 'status' } as const,
  { state: 'idle' as TotemState, since: 0 },
  { shape: 'status-1' },
)
const peers = atom({ plugin: 'totem', key: 'peers' } as const, [] as TotemPeer[], { shape: 'peers-1' })

const PANE = 'totem'
const HEARTBEAT_MS = 5000
const POLL_MS = 2500
const FRAME_MS = 33

/** What this session knows about its terminal; rebuilt on every load. */
type Runtime = {
  dir: string
  home: string
  root: string
  tty: string | null
  program: Program
  id: string
  isTinted: boolean
  /**
   * Claude Code was started with its own titles off, so the tab is totem's
   * alone. Otherwise Claude rewrites it while it works, and totem puts the
   * project back each time it stops.
   */
  ownsTitle: boolean
  timers: Timer[]
}

const TITLE_ENV = 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'
const isOn = (value: string | undefined) => !!value && /^(1|true|yes|on)$/i.test(value.trim())

/** The big name as last drawn, so a timer can repaint it frame by frame. */
type Drawn = { requestId: string; grid: boolean[][]; identity: TotemIdentity; isLight: boolean }

// Module state: a reload starts it over, which is what it describes.
let options: Options = settle({})
let rt: Runtime | null = null
let drawn: Drawn | null = null
const motion = {
  reveal: 1,
  head: null as number | null,
  timer: null as Timer | null,
  isArrivalQueued: false,
}

const ease = (t: number) => 1 - (1 - t) ** 3

async function gitInfo($: $, root: string) {
  const run = (args: string[]) =>
    $.process.run(['git', '-C', root, ...args], { timeoutMs: 4000 }).catch(() => null)
  const [branch, dirs] = await Promise.all([
    run(['branch', '--show-current']),
    run(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']),
  ])
  const [gitDir, commonDir] = dirs?.exitCode === 0 ? dirs.stdout.trim().split('\n') : []

  return {
    branch: branch?.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : null,
    isWorktree: !!gitDir && !!commonDir && gitDir !== commonDir,
  }
}

async function themeIsLight($: $): Promise<boolean> {
  try {
    const theme = await $.settings.read({ key: 'theme' })
    return typeof theme === 'string' && theme.startsWith('light')
  } catch {
    return false
  }
}

function titleFor(v: TotemView, state: TotemState): string {
  if (!v.identity) return `✦ ${basename(v.path)}`
  const mark = state === 'idle' ? '' : ` ${GLYPH[state]}`
  const branch = v.isWorktree && v.branch ? ` ⑂${v.branch}` : ''

  return `${v.identity.emoji} ${v.identity.name}${branch}${mark}`
}

async function retitle($: $) {
  if (!options.title || !rt?.tty) return
  const [v, s] = await Promise.all([read($, view), read($, status)])
  if (rt?.tty) await write($, rt.tty, osc.title(titleFor(v, s.state)))
}

/** Puts the project's title back just after Claude Code wrote its own. */
function reclaimTitle($: $) {
  if (options.title && rt && !rt.ownsTitle) $.clock.after(400, () => retitle($))
}

/** Tints the terminal, fading from `from` where there is one to fade from. */
async function tint($: $, from: Rgb | null) {
  if (!rt?.tty) return
  if (!options.tint) {
    // Unconditionally: a reload after the tint was switched off in /config
    // starts with no memory of having tinted.
    await write($, rt.tty, osc.resetBackground())
    rt.isTinted = false
    return
  }
  const v = await read($, view)
  if (!v.identity) return
  const to = palette(v.identity.hue, v.isLight, v.identity.chroma).tint
  rt.isTinted = true
  if (from && options.motion !== 'off') {
    const steps = 14
    const frames = Array.from({ length: steps }, (_, i) =>
      osc.background(mix(from, to, ease((i + 1) / steps))),
    )
    await play($, rt.tty, frames, 32)
  } else {
    await write($, rt.tty, osc.background(to))
  }
}

/** One gentle swell of the background when Claude hands the turn back. */
async function breathe($: $) {
  if (!rt?.tty || !options.tint || options.motion !== 'full') return
  const v = await read($, view)
  if (!v.identity) return
  const colors = palette(v.identity.hue, v.isLight, v.identity.chroma)
  const peak = mix(colors.tint, colors.ink, v.isLight ? 0.1 : 0.16)
  const up = [0.35, 0.7, 1].map(t => osc.background(mix(colors.tint, peak, ease(t))))
  const down = [0.8, 0.6, 0.4, 0.2, 0.08, 0].map(t => osc.background(mix(colors.tint, peak, t)))
  await play($, rt.tty, [...up, ...down], 45)
}

async function beat($: $) {
  if (!rt) return
  const [v, s, now] = await Promise.all([read($, view), read($, status), $.clock.now()])
  if (!v.identity || !rt) return
  await publish($, rt.dir, {
    id: rt.id,
    key: v.identity.key,
    name: v.identity.name,
    emoji: v.identity.emoji,
    hue: v.identity.hue,
    chroma: v.identity.chroma,
    tty: rt.tty,
    program: rt.program.name,
    pane: rt.program.pane,
    state: s.state,
    since: s.since,
    seenAt: now,
    cwd: v.path,
    branch: v.branch,
  })
}

/** A turn elsewhere this long is worth a word when it ends. */
const LONG_TURN_MS = 30_000

async function refreshPeers($: $) {
  if (!rt) return
  const now = await $.clock.now()
  const found = await scan($, rt.dir, rt.id, now)
  const current = await read($, peers)
  const sign = (list: readonly TotemPeer[]) =>
    JSON.stringify(list.map(p => [p.id, p.name, p.emoji, p.hue, p.state, p.since, p.branch]))
  if (sign(found) === sign(current)) return
  await update($, peers, () => found)
  if (options.nudges) nudge($, current, found)
}

/**
 * Says so in this session when another one starts needing you, or finishes a
 * long turn: whichever session you are looking at hears about the others.
 */
function nudge($: $, before: readonly TotemPeer[], after: readonly TotemPeer[]) {
  const was = new Map(before.map(p => [p.id, p]))
  for (const peer of after) {
    const last = was.get(peer.id)
    if (!last || last.state === peer.state) continue
    const who = `${peer.emoji} ${peer.name}`
    if (peer.state === 'needs') {
      $.ui.toast(`● ${who} needs you · /totem jump ${peer.name}`, { timeoutMs: 8000 })
    } else if (peer.state === 'done' && last.state === 'working' && peer.since - last.since >= LONG_TURN_MS) {
      $.ui.toast(`✓ ${who} finished after ${age(peer.since - last.since)} · /totem jump ${peer.name}`, {
        timeoutMs: 6000,
      })
    }
  }
}

/** The branch moves under a session (a checkout, a new worktree): follow it. */
async function refreshGit($: $) {
  if (!rt) return
  const git = await gitInfo($, rt.root)
  const v = await read($, view)
  if (git.branch !== v.branch || git.isWorktree !== v.isWorktree) {
    await update($, view, current => ({ ...current, branch: git.branch, isWorktree: git.isWorktree }))
    await beat($)
  }
}

async function markArrived($: $) {
  motion.isArrivalQueued = false
  await update($, view, current => ({ ...current, hasArrived: true }))
}

/** Repaints the big name on a timer: the reveal on arrival, or one sweep. */
function animate($: $, kind: 'arrive' | 'sweep') {
  const target = drawn
  if (!target || options.motion !== 'full') {
    if (kind === 'arrive') void markArrived($)
    return
  }
  motion.timer?.cancel()
  const width = target.grid[0]?.length ?? 0
  const total = kind === 'arrive' ? 24 : 16
  const colors = palette(target.identity.hue, target.isLight, target.identity.chroma)
  let i = 0
  motion.reveal = kind === 'arrive' ? 0 : 1
  motion.timer = $.clock.every(FRAME_MS, async () => {
    i += 1
    const t = Math.min(1, i / total)
    if (kind === 'arrive') {
      motion.reveal = ease(t)
      motion.head = Math.round(motion.reveal * (width + 3))
    } else {
      motion.reveal = 1
      motion.head = Math.round(-3 + ease(t) * (width + 6))
    }
    const isLast = i >= total
    if (isLast) {
      motion.timer?.cancel()
      motion.timer = null
      motion.reveal = 1
      motion.head = null
    }
    try {
      await $.ui.blit({
        requestId: target.requestId,
        key: NAME_KEY,
        cells: frame(target.grid, colors, motion.reveal, motion.head),
      })
    } catch {
      // Collapsed or redrawn meanwhile: the last frame's redraw covers it.
    }
    if (isLast) {
      if (kind === 'arrive') await markArrived($)
      $.ui.invalidate('ui.render')
    }
  })
}

function attention($: $) {
  animate($, 'sweep')
  void breathe($)
}

async function setState($: $, next: TotemState) {
  const prev = await read($, status)
  if (prev.state === next) return
  const now = await $.clock.now()
  await update($, status, () => ({ state: next, since: now }))
  await Promise.all([beat($), retitle($)])
  if (prev.state === 'working' && (next === 'done' || next === 'needs')) {
    $.clock.after(0, () => attention($))
  }
}

async function boot($: $, cwd: string) {
  const home = (await $.env.get('HOME')) ?? ''
  // TOTEM_HOME keeps a session's totems and radar apart from everyone
  // else's: a test or demo session sees only its own kind.
  const dir = (await $.env.get('TOTEM_HOME'))?.trim() || `${home}/.claude/totem`
  const [tty, program, sessionId, root, repo] = await Promise.all([
    findTty($),
    detectProgram($),
    $.session.id(),
    $.session.root().catch(() => cwd),
    $.session.repo().catch(() => null),
  ])
  const key = repo?.root ?? root
  const [git, base] = await Promise.all([
    gitInfo($, root),
    tty ? readBackground($, program, tty) : Promise.resolve(null),
  ])
  const isLight = base ? luminance(base) > 0.35 : await themeIsLight($)
  // Claude Code reads this once, at launch: setting it now would change
  // nothing, so totem only reads it.
  const ownsTitle = isOn(await $.env.get('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'))
  const runtime: Runtime = {
    dir,
    home,
    root,
    tty,
    program,
    id: liveId(tty, sessionId),
    isTinted: false,
    ownsTitle,
    timers: [],
  }
  rt = runtime

  const now = await $.clock.now()
  const known = await recall($, dir, key)
  const prev = await read($, view)
  const path = home && root.startsWith(home) ? `~${root.slice(home.length)}` : root
  await update($, view, () => ({
    identity: known,
    isForging: !known,
    isLight,
    path,
    branch: git.branch,
    isWorktree: git.isWorktree,
    hasArrived: !!prev.hasArrived && prev.identity?.key === key,
  }))
  if ((await read($, status)).since === 0) {
    await update($, status, () => ({ state: 'idle' as TotemState, since: now }))
  }

  if (known) {
    await putSaved($, dir, known, now)
  } else {
    await retitle($)
    const live = await scan($, dir, runtime.id, now)
    const identity = await forge($, dir, key, {
      ai: options.ai,
      now,
      avoid: live.filter(p => p.key !== key).map(p => p.hue),
    })
    await update($, view, v => ({ ...v, identity, isForging: false, hasArrived: false }))
  }

  // The fade starts from what the person sees now: the tab's own color the
  // first time, the tint itself after a reload.
  await tint($, base)
  await retitle($)
  reclaimTitle($)
  await beat($)
  await refreshPeers($)

  runtime.timers.push(
    $.clock.every(HEARTBEAT_MS, () => beat($)),
    $.clock.every(POLL_MS, () => refreshPeers($)),
    $.clock.every(30_000, async () => {
      await refreshGit($)
      $.ui.invalidate('ui.render')
    }),
  )
}

async function shutdown($: $) {
  const ending = rt
  if (!ending) return
  rt = null
  for (const timer of ending.timers) timer.cancel()
  motion.timer?.cancel()
  const reset = (ending.isTinted ? osc.resetBackground() : '') + (options.title ? osc.title('') : '')
  await Promise.all([
    ending.tty && reset ? write($, ending.tty, reset) : undefined,
    retire($, ending.dir, ending.id),
  ])
}

async function jump($: $, peer: TotemPeer): Promise<boolean> {
  const isThere = await focus($, peer)
  if (!isThere) {
    $.ui.toast(
      peer.tty || peer.pane
        ? `Couldn't bring ${peer.name} forward: jumping isn't supported in ${peer.program} yet.`
        : `${peer.name} runs somewhere totem can't reach.`,
    )
  }

  return isThere
}

async function openPane($: $) {
  await $.ui.open({ id: PANE, title: 'Totem', focus: true, closeOnEscape: true })
}

function wordFor(
  identity: TotemIdentity,
  isLight: boolean,
  reveal: number,
  head: number | null,
): { word: Word; grid: boolean[][] } | null {
  const text = spell(identity.name)
  if (!canDraw(text)) return null
  const grid = rasterize(text)
  const colors = palette(identity.hue, isLight, identity.chroma)

  return { grid, word: { width: measure(text), cells: frame(grid, colors, reveal, head) } }
}

/** Saves a change to this project's totem and repaints everything with it. */
async function amend($: $, change: Partial<TotemIdentity>): Promise<TotemIdentity | null> {
  if (!rt) return null
  const v = await read($, view)
  if (!v.identity) return null
  const before = palette(v.identity.hue, v.isLight, v.identity.chroma).tint
  const identity: TotemIdentity = { ...v.identity, ...change, source: 'user' }
  await putSaved($, rt.dir, identity, await $.clock.now())
  await update($, view, current => ({ ...current, identity }))
  await tint($, before)
  await Promise.all([retitle($), beat($)])
  $.clock.after(0, () => animate($, 'sweep'))

  return identity
}

async function recolor($: $, arg: string): Promise<string> {
  const v = await read($, view)
  if (!v.identity || !rt) return 'still forging, try again in a moment.'
  const own = v.identity
  let change: { hue: number; chroma: number } | null = null
  const rgb = parseHex(arg)
  if (rgb) {
    const picked = toOklch(rgb)
    change = { hue: Math.round(picked.hue), chroma: Math.min(1, picked.C / 0.12) }
  } else if (/^\d{1,3}$/.test(arg)) {
    change = { hue: Number(arg) % 360, chroma: 1 }
  } else if (arg === '' || arg === 'next') {
    const live = await read($, peers)
    const open = [...live.filter(p => p.key !== own.key).map(p => p.hue), own.hue]
    const recent = await recentHues($, rt.dir, own.key, await $.clock.now())
    change = { hue: chooseHue((own.hue + 137.5) % 360, open, recent), chroma: 1 }
  }
  if (!change) return 'give a hex color (#7c3aed), a hue (0-359) or `next`.'
  const next = await amend($, change)

  return next ? `${next.emoji} ${next.name} is now hue ${next.hue}°.` : 'not running in this session.'
}

async function share($: $): Promise<string> {
  const v = await read($, view)
  if (!v.identity) return 'nothing to share yet.'
  const { key, name, emoji, hue, chroma } = v.identity
  const color = hex(oklch(0.62, 0.15 * chroma, hue))
  await $.fs.write(`${key}/.claude/totem.json`, JSON.stringify({ name, emoji, color }, null, 2) + '\n')

  return `Wrote \`.claude/totem.json\` (${emoji} ${name}, ${color}). Commit it and everyone on the team who runs totem gets the same totem for this repo.`
}

async function reroll($: $): Promise<string> {
  if (!rt) return 'not running in this session.'
  const v = await read($, view)
  if (!v.identity) return 'still forging.'
  const own = v.identity
  const before = palette(own.hue, v.isLight, own.chroma).tint
  await update($, view, current => ({ ...current, isForging: true }))
  const live = await read($, peers)
  const identity = await forge($, rt.dir, own.key, {
    ai: options.ai,
    now: await $.clock.now(),
    avoid: [own.hue, ...live.filter(p => p.key !== own.key).map(p => p.hue)],
  })
  await update($, view, current => ({ ...current, identity, isForging: false, hasArrived: false }))
  await tint($, before)
  await Promise.all([retitle($), beat($)])

  return `new totem: ${identity.emoji} ${identity.name} at hue ${identity.hue}°.`
}

async function jumpTo($: $, arg: string): Promise<string> {
  const list = await read($, peers)
  const wanted = arg.toLowerCase()
  const peer =
    list.find(p => p.name.toLowerCase() === wanted) ??
    list.find(p => p.name.toLowerCase().startsWith(wanted)) ??
    (wanted ? undefined : list[0])
  if (!peer) return `no live session named "${arg}".`

  return (await jump($, peer)) ? `jumped to ${peer.emoji} ${peer.name}.` : `couldn't jump to ${peer.name}.`
}

async function doctor($: $): Promise<string> {
  const lines = ['doctor', '']
  const v = await read($, view)
  const program = rt?.program ?? (await detectProgram($))
  const tty = rt?.tty ?? null
  lines.push(`- terminal: ${program.name}${tty ? `, tty ${tty}` : ', no tty found'}`)
  if (!tty) lines.push('  - Without a tty totem draws its band but cannot tint the terminal or name the tab.')
  lines.push(`- tint: ${options.tint ? 'on (OSC 11)' : 'off'}`)
  lines.push(`- tab title: ${options.title ? 'on' : 'off'}`)
  if (options.title) {
    lines.push(
      rt?.ownsTitle
        ? "  - Claude Code's own titles are off, so the tab keeps the project's name the whole time."
        : `  - Claude Code still writes its own title while it works, so the tab shows the project only between turns. Run /totem setup (it adds ${TITLE_ENV}=1 to ~/.claude/settings.json), then restart your sessions.`,
    )
  }
  const extras = await terminalAppTabExtras($, program, tty)
  if (extras && (extras.process || extras.args)) {
    lines.push(
      `- Terminal.app's "${extras.profile}" profile appends the process${extras.args ? ' and its arguments' : ''} to every tab title, so narrow tabs show "…ode • claude --resume" instead of the project.`,
      `  - Fix once: Terminal → Settings → Profiles → ${extras.profile} → Tab, then uncheck "Active process name" and "Arguments".`,
    )
  } else if (extras) {
    lines.push(`- Terminal.app tab titles: clean (the "${extras.profile}" profile adds no process name).`)
  }
  const list = await read($, peers)
  lines.push(`- radar: ${list.length} other session${list.length === 1 ? '' : 's'} live${rt ? `, in ${rt.dir}` : ''}`)
  if (v.identity) {
    lines.push(
      `- this project: ${v.identity.emoji} ${v.identity.name}, hue ${v.identity.hue}°, ${v.identity.source}`,
      `- options: band ${options.band}, motion ${options.motion}, ai ${options.ai ? 'on' : 'off'} (change them in /config)`,
    )
  }

  return lines.join('\n')
}

/**
 * Turns Claude Code's own terminal titles off in ~/.claude/settings.json, the
 * one change totem asks of the person's setup, and only when they run it.
 */
async function setup($: $): Promise<string> {
  const home = rt?.home ?? (await $.env.get('HOME')) ?? ''
  const path = `${home}/.claude/settings.json`
  let settings: Record<string, unknown> = {}
  if (await $.fs.exists(path)) {
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(path))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      settings = parsed as Record<string, unknown>
    } catch {
      return `couldn't read ${path} as JSON, so nothing changed. Add "env": { "${TITLE_ENV}": "1" } to it by hand.`
    }
  }
  const env =
    settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {}
  const tip =
    rt?.program.name === 'Apple_Terminal'
      ? '\nIn Terminal.app, also uncheck "Active process name" and "Arguments" under Settings → Profiles → Tab, so narrow tabs show the project and not "…ode • claude".'
      : ''
  if (isOn(typeof env[TITLE_ENV] === 'string' ? (env[TITLE_ENV] as string) : undefined)) {
    return `${TITLE_ENV} is already on in ${path}.${rt?.ownsTitle ? '' : ' Restart this session for it to take effect.'}${tip}`
  }
  settings.env = { ...env, [TITLE_ENV]: '1' }
  await $.fs.write(path, JSON.stringify(settings, null, 2) + '\n')

  return `Added "${TITLE_ENV}": "1" to the env block of ${path}: Claude Code stops writing its own tab titles, so every tab keeps its project's name. Restart your sessions to pick it up. To undo, delete that line.${tip}`
}

async function runCommand($: $, args: string): Promise<string | undefined> {
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').trim()

  switch (sub.toLowerCase()) {
    case '':
    case 'show':
      await openPane($)
      return undefined
    case 'color':
    case 'colour':
      return recolor($, arg)
    case 'emoji': {
      const emoji = settleEmoji(arg)
      if (!emoji) return 'give one emoji that is a single character, like `/totem emoji 🦊`.'
      const next = await amend($, { emoji })
      return next ? `${next.emoji} ${next.name}` : 'not running in this session.'
    }
    case 'name': {
      const name = arg.slice(0, 40)
      if (!name) return 'give a name, like `/totem name Daisy UI`.'
      const next = await amend($, { name })
      return next ? `this project is now ${next.emoji} ${next.name}.` : 'not running in this session.'
    }
    case 'share':
      return share($)
    case 'reroll':
      return reroll($)
    case 'jump':
      return jumpTo($, arg)
    case 'doctor':
      return doctor($)
    case 'setup':
      return setup($)
    default:
      return '/totem shows this project and your other sessions. Also: color, emoji, name, share, reroll, jump, doctor, setup.'
  }
}

export const register: Register = (on, rawOptions) => {
  options = settle(rawOptions)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    await $.command.register({
      name: 'totem',
      description: 'This project’s totem and your other sessions: color, emoji, name, share, reroll, jump, doctor, setup',
      argumentHint: '[color <#hex|hue|next> | emoji <e> | name <text> | share | reroll | jump <project> | doctor | setup]',
    })
    $.clock.after(0, () => boot($, e.cwd))

    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') await shutdown($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await setState($, 'working')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      await setState($, e.isAborted ? 'idle' : 'done')
      reclaimTitle($)
      $.clock.after(0, () => refreshGit($))
    }

    return done
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const isAsk =
      e.notification_type === 'permission_prompt' ||
      e.notification_type === 'elicitation_dialog' ||
      /permission|needs your|approve/i.test(e.message)
    if (isAsk) await setState($, 'needs')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') await setState($, 'needs')
    const ran = await next(e)
    if ((await read($, status)).state === 'needs') await setState($, 'working')

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    if ((await read($, status)).state === 'done') await setState($, 'idle')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'totem' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  // Any slash command can make Claude Code write its own title.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    reclaimTitle($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (options.band === 'off' || e.props.hasSurvey) return next(e)
    const v = await read($, view)
    const el = $.ui.resolve(e)
    if (v.isForging && !v.identity) return Forging(el, basename(v.path) || 'this project')
    if (!v.identity) return next(e)
    const [s, list, now] = await Promise.all([read($, status), read($, peers), $.clock.now()])

    // Pixel letters are the terminal's alone: other tables carry a Raster that
    // draws nothing.
    const isTerminal = e.surface === 'terminal'
    const isArriving = options.motion === 'full' && !v.hasArrived
    const isMoving = motion.timer !== null
    const reveal = isMoving ? motion.reveal : isArriving ? 0 : 1
    const drawing = isTerminal ? wordFor(v.identity, v.isLight, reveal, isMoving ? motion.head : null) : null
    if (drawing) {
      drawn = { requestId: e.requestId, grid: drawing.grid, identity: v.identity, isLight: v.isLight }
    }
    if (isArriving && drawing && !isMoving && !motion.isArrivalQueued) {
      motion.isArrivalQueued = true
      $.clock.after(120, () => animate($, 'arrive'))
    }

    return Band({
      el,
      columns: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      style: options.band === 'bar' ? 'bar' : 'big',
      view: v,
      identity: v.identity,
      state: s.state,
      since: s.since,
      now,
      peers: list,
      word: drawing?.word ?? null,
      onJump: peer => void jump($, peer),
      onMore: () => void openPane($),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const v = await read($, view)
    const { Text } = el
    if (!v.identity) return <Text dimColor>Forging this project’s totem…</Text>
    const [s, list, now] = await Promise.all([read($, status), read($, peers), $.clock.now()])
    const drawing = e.surface === 'terminal' ? wordFor(v.identity, v.isLight, 1, null) : null

    return Pane({
      el,
      columns: e.props.bodyColumns,
      view: v,
      identity: v.identity,
      state: s.state,
      since: s.since,
      now,
      peers: list,
      word: drawing?.word ?? null,
      onJump: peer => void jump($, peer),
    })
  })
}
