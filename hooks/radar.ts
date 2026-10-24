// Every session totem runs in keeps one small file under ~/.claude/totem/live,
// refreshed on a heartbeat, so each session can see the others: which project,
// which tab, and whether it is working, needs you, or is done.

import type { EngineInterface } from 'claude-code'

import type { TotemPeer, TotemState } from '../types'

type $ = EngineInterface

/** A heartbeat older than this is a session that went away. */
export const STALE_MS = 20_000
/** A file this old is swept away by whichever session finds it. */
const SWEEP_MS = 10 * 60_000

/** One file per terminal: a tty holds one CLI at a time, and /clear keeps it. */
export function liveId(tty: string | null, sessionId: string): string {
  return (tty ? tty.replace(/^\/dev\//, '').replace(/\//g, '-') : sessionId).slice(0, 80)
}

export async function publish($: $, dir: string, peer: TotemPeer): Promise<void> {
  try {
    await $.fs.write(`${dir}/live/${peer.id}.json`, JSON.stringify(peer) + '\n')
  } catch {
    // The radar is a nicety: a failed write costs one heartbeat.
  }
}

export async function retire($: $, dir: string, id: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', `${dir}/live/${id}.json`], { timeoutMs: 3000 })
  } catch {
    // Its heartbeat stops either way, and the others drop it.
  }
}

export async function scan($: $, dir: string, selfId: string, now: number): Promise<TotemPeer[]> {
  let entries: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(`${dir}/live`)
  } catch {
    return []
  }
  const files = entries.filter(
    entry => entry.kind === 'file' && entry.name.endsWith('.json') && entry.name !== `${selfId}.json`,
  )
  const swept = files.filter(entry => now - entry.mtimeMs > SWEEP_MS)
  if (swept.length > 0) {
    try {
      await $.process.run(['rm', '-f', ...swept.map(entry => `${dir}/live/${entry.name}`)], {
        timeoutMs: 3000,
      })
    } catch {
      // Swept next time.
    }
  }
  const peers = await Promise.all(
    files
      .filter(entry => now - entry.mtimeMs <= STALE_MS * 2)
      .map(async entry => {
        try {
          return JSON.parse(await $.fs.read(`${dir}/live/${entry.name}`)) as TotemPeer
        } catch {
          return null
        }
      }),
  )

  return peers
    .filter((p): p is TotemPeer => !!p && typeof p.name === 'string' && now - p.seenAt <= STALE_MS)
    .sort(byUrgency)
}

const RANK: Record<TotemState, number> = { needs: 0, done: 1, working: 2, idle: 3 }

/** Whoever needs you first, then whoever finished, then the rest, newest first. */
export function byUrgency(a: TotemPeer, b: TotemPeer): number {
  return RANK[a.state] - RANK[b.state] || b.since - a.since
}

export const GLYPH: Record<TotemState, string> = {
  working: '◐',
  needs: '●',
  done: '✓',
  idle: '○',
}

export const LABEL: Record<TotemState, string> = {
  working: 'working',
  needs: 'needs you',
  done: 'your turn',
  idle: 'ready',
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)

  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}
