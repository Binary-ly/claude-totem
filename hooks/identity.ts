// Who a project is: its name, its emoji and its hue, settled once and kept.
//
// In order: a `.claude/totem.json` the team committed, then the person's own
// pick under ~/.claude/totem/projects, then a new totem: a small model reads
// the project's name and README for an emoji and a hue that fit, and the hue
// is moved clear of the projects the person has had open lately.

import type { EngineInterface } from 'claude-code'

import type { TotemIdentity } from '../types'
import { chooseHue, hash, parseHex, toOklch } from './color'

type $ = EngineInterface

export type TeamFile = { name?: string; emoji?: string; color?: string }

type Saved = TotemIdentity & { seenAt: number }

const RECENT_MS = 14 * 24 * 60 * 60 * 1000

// Single code points with emoji presentation, so every terminal gives them two
// cells and the layout around them holds.
const FALLBACK_EMOJI = [
  '🦊', '🐙', '🦉', '🐝', '🦋', '🐢', '🦄', '🐳', '🦖', '🦩', '🐧', '🦔',
  '🌵', '🍄', '🌻', '🍋', '🍉', '🍒', '🥑', '🍩', '🧊', '🪐', '🌙', '🔥',
  '🌊', '💎', '🎲', '🧩', '🎈', '🪁', '🧭', '🔮', '🧪', '🛸', '🚂', '🦀',
]

const isOneEmoji = (text: string) => {
  try {
    return /^\p{Emoji_Presentation}$/u.test(text)
  } catch {
    return FALLBACK_EMOJI.includes(text)
  }
}

/** The emoji with any variation selector dropped, if one code point is left. */
export function settleEmoji(text: string | undefined): string | null {
  if (!text) return null
  const bare = text.replace(/️|︎/g, '').trim()

  return isOneEmoji(bare) ? bare : null
}

export const basename = (path: string) =>
  path.replace(/\/+$/, '').split('/').pop() || path

export function slug(key: string): string {
  const name = basename(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)

  return `${name || 'root'}-${hash(key).toString(16).padStart(8, '0')}`
}

export function hashed(key: string): { emoji: string; hue: number } {
  const h = hash(key)

  return {
    emoji: FALLBACK_EMOJI[h % FALLBACK_EMOJI.length]!,
    hue: (h >>> 8) % 360,
  }
}

async function readJson<T>($: $, path: string): Promise<T | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}

export async function readTeamFile($: $, root: string): Promise<TeamFile | null> {
  const file = await readJson<TeamFile>($, `${root}/.claude/totem.json`)

  return file && typeof file === 'object' ? file : null
}

export function fromTeamFile(key: string, file: TeamFile): Partial<TotemIdentity> {
  const out: Partial<TotemIdentity> = { key, source: 'team' }
  if (typeof file.name === 'string' && file.name.trim()) out.name = file.name.trim().slice(0, 40)
  const emoji = settleEmoji(file.emoji)
  if (emoji) out.emoji = emoji
  const rgb = typeof file.color === 'string' ? parseHex(file.color) : null
  if (rgb) {
    const { C, hue } = toOklch(rgb)
    out.hue = Math.round(hue)
    out.chroma = Math.min(1, C / 0.12)
  }

  return out
}

// The person's own record, one file per project under `<dir>/projects`.

const savedPath = (dir: string, key: string) => `${dir}/projects/${slug(key)}.json`

export async function getSaved($: $, dir: string, key: string): Promise<Saved | null> {
  const saved = await readJson<Saved>($, savedPath(dir, key))

  return saved && saved.key === key ? saved : null
}

export async function putSaved($: $, dir: string, identity: TotemIdentity, seenAt: number): Promise<void> {
  const saved: Saved = { ...identity, seenAt }
  await $.fs.write(savedPath(dir, identity.key), JSON.stringify(saved, null, 2) + '\n')
}

/** Hues of the other projects opened in the last two weeks. */
export async function recentHues($: $, dir: string, except: string, now: number): Promise<number[]> {
  let names: string[] = []
  try {
    names = (await $.fs.list(`${dir}/projects`))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(entry => entry.name)
  } catch {
    return []
  }
  const all = await Promise.all(names.map(name => readJson<Saved>($, `${dir}/projects/${name}`)))

  return all
    .filter((s): s is Saved => !!s && s.key !== except && now - (s.seenAt ?? 0) < RECENT_MS)
    .filter(s => s.chroma > 0.2)
    .map(s => s.hue)
}

/** A line or two of what the project says about itself, for the model. */
async function describe($: $, root: string): Promise<string> {
  const parts: string[] = []
  const pkg = await readJson<{ description?: string; keywords?: string[] }>(
    $,
    `${root}/package.json`,
  )
  if (pkg?.description) parts.push(`package.json: ${pkg.description}`)
  if (pkg?.keywords?.length) parts.push(`keywords: ${pkg.keywords.slice(0, 8).join(', ')}`)
  const composer = await readJson<{ description?: string }>($, `${root}/composer.json`)
  if (composer?.description) parts.push(`composer.json: ${composer.description}`)
  for (const name of ['README.md', 'readme.md', 'README', 'Readme.md']) {
    try {
      const text = await $.fs.read(`${root}/${name}`)
      const prose = text
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/[#>*_`|-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (prose) parts.push(`README: ${prose.slice(0, 700)}`)
      break
    } catch {
      // No README by that name.
    }
  }

  return parts.join('\n')
}

/** Asks a small model for an emoji and a hue that suit the project. */
export async function imagine(
  $: $,
  root: string,
  name: string,
): Promise<{ emoji: string; hue: number } | null> {
  const about = await describe($, root)
  const prompt = [
    `Project folder: ${name}`,
    about,
    '',
    'Give this project a tiny visual identity for a terminal:',
    '- "emoji": ONE emoji, a single code point (no ZWJ sequences, no flags, no keycaps), that captures what the project is or what its name evokes. Avoid generic picks (💻 📁 🚀 ✨ ⚡ 🔧 📦) unless nothing else fits.',
    '- "hue": an OKLCH hue angle from 0 to 359 that suits it (its brand, its subject, its mood).',
    'Reply with one line of JSON and nothing else, like {"emoji":"🌼","hue":95}',
  ].join('\n')
  try {
    const result = await $.model.complete({
      model: 'haiku',
      system: 'You design small, memorable identities for software projects.',
      prompt,
      maxTokens: 60,
      timeoutMs: 8000,
    })
    if (!result.isAnswered) return null
    const json = /\{[^{}]*\}/.exec(result.text)?.[0]
    if (!json) return null
    const picked = JSON.parse(json) as { emoji?: string; hue?: number }
    const emoji = settleEmoji(picked.emoji)
    const hue = Number(picked.hue)
    if (!emoji || !Number.isFinite(hue)) return null

    return { emoji, hue: ((Math.round(hue) % 360) + 360) % 360 }
  } catch {
    return null
  }
}

/** What is on record for the project, or null when it has no totem yet. */
export async function recall($: $, dir: string, key: string): Promise<TotemIdentity | null> {
  const team = await readTeamFile($, key)
  const saved = await getSaved($, dir, key)
  // Your own pick (/totem color, emoji, name) outranks the team's file.
  if (saved?.source === 'user') {
    const { seenAt: _seenAt, ...identity } = saved
    return identity
  }
  const fromTeam = team ? fromTeamFile(key, team) : {}
  const base = saved ?? null
  if (!base && fromTeam.hue === undefined) return null
  const fallback = hashed(key)

  return {
    key,
    name: fromTeam.name ?? base?.name ?? basename(key),
    emoji: fromTeam.emoji ?? base?.emoji ?? fallback.emoji,
    hue: fromTeam.hue ?? base?.hue ?? fallback.hue,
    chroma: fromTeam.chroma ?? base?.chroma ?? 1,
    source: fromTeam.hue !== undefined || fromTeam.emoji ? 'team' : (base?.source ?? 'auto'),
  }
}

/** A new totem for a project that has none, saved before it is returned. */
export async function forge(
  $: $,
  dir: string,
  key: string,
  options: { ai: boolean; now: number; avoid: readonly number[] },
): Promise<TotemIdentity> {
  const team = await readTeamFile($, key)
  const fromTeam = team ? fromTeamFile(key, team) : {}
  const name = fromTeam.name ?? basename(key)
  const picked = options.ai ? await imagine($, key, name) : null
  const fallback = hashed(key)
  const recent = await recentHues($, dir, key, options.now)
  const identity: TotemIdentity = {
    key,
    name,
    emoji: fromTeam.emoji ?? picked?.emoji ?? fallback.emoji,
    hue: fromTeam.hue ?? chooseHue(picked?.hue ?? fallback.hue, options.avoid, recent),
    chroma: fromTeam.chroma ?? 1,
    source: fromTeam.hue !== undefined ? 'team' : 'auto',
  }
  await putSaved($, dir, identity, options.now)

  return identity
}
