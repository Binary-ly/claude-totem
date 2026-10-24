// A 5-pixel font drawn with half blocks: two pixels per cell, one above the
// other, so a cell's pixels come out square and a word stands 3 rows tall.

import { packed, type Palette } from './color'

const GLYPHS: Record<string, readonly string[]> = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  B: ['###.', '#..#', '###.', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '.###'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
  F: ['####', '#...', '###.', '#...', '#...'],
  G: ['.###', '#...', '#.##', '#..#', '.###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..##', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
  L: ['#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '###.', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#.#.', '.#.#'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
  Z: ['####', '...#', '.##.', '#...', '####'],
  '0': ['.##.', '#.##', '##.#', '#..#', '.##.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###.', '...#', '.##.', '#...', '####'],
  '3': ['###.', '...#', '.##.', '...#', '###.'],
  '4': ['#..#', '#..#', '####', '...#', '...#'],
  '5': ['####', '#...', '###.', '...#', '###.'],
  '6': ['.##.', '#...', '###.', '#..#', '.##.'],
  '7': ['####', '...#', '..#.', '.#..', '.#..'],
  '8': ['.##.', '#..#', '.##.', '#..#', '.##.'],
  '9': ['.##.', '#..#', '.###', '...#', '.##.'],
  '-': ['...', '...', '###', '...', '...'],
  _: ['...', '...', '...', '...', '###'],
  '.': ['.', '.', '.', '.', '#'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '&': ['.#..', '#.#.', '.#..', '#.#.', '.#.#'],
  '@': ['.##.', '#..#', '#.##', '#...', '.###'],
  '/': ['...#', '..#.', '.#..', '.#..', '#...'],
  ' ': ['..', '..', '..', '..', '..'],
}

const ROWS = 3
const SPACING = 1
const DEFAULT = 0x01000000
const UPPER = 0x2580
const LOWER = 0x2584
const FULL = 0x2588
const BLANK = 0x20

/** The name as the font spells it: uppercase, accents dropped. */
export function spell(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function canDraw(text: string): boolean {
  return text.length > 0 && [...text].every(ch => ch in GLYPHS)
}

/** Columns the word takes. */
export function measure(text: string): number {
  const glyphs = [...text].map(ch => GLYPHS[ch]?.[0]?.length ?? 0)

  return glyphs.reduce((sum, w) => sum + w, 0) + SPACING * Math.max(0, glyphs.length - 1)
}

/** The word's pixels, 6 rows (5 drawn and 1 blank) by `measure(text)` columns. */
export function rasterize(text: string): boolean[][] {
  const width = measure(text)
  const grid = Array.from({ length: ROWS * 2 }, () => new Array<boolean>(width).fill(false))
  let x = 0
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (!glyph) continue
    const w = glyph[0]?.length ?? 0
    glyph.forEach((line, y) => {
      for (let i = 0; i < w; i++) if (line[i] === '#') grid[y]![x + i] = true
    })
    x += w + SPACING
  }

  return grid
}

/**
 * One frame of the word as Raster cells.
 *
 * `reveal` is how far a left-to-right reveal has come (0 none, 1 all), and
 * `head` the column a bright scan head stands on (null for none): the reveal
 * on arrival and the sweep when Claude needs you are both a moving head.
 */
export function frame(
  grid: boolean[][],
  colors: Palette,
  reveal: number,
  head: number | null,
): string {
  const width = grid[0]?.length ?? 0
  const words = new Uint32Array(width * ROWS * 3)
  const ink = packed(colors.ink)
  const glint = packed(colors.glint)
  const shown = reveal >= 1 ? Infinity : Math.floor(reveal * width)

  for (let row = 0; row < ROWS; row++) {
    for (let x = 0; x < width; x++) {
      const top = grid[row * 2]?.[x] === true && x < shown
      const bottom = grid[row * 2 + 1]?.[x] === true && x < shown
      const isHead = head !== null && x <= head && x > head - 3
      const at = (row * width + x) * 3
      words[at] = top && bottom ? FULL : top ? UPPER : bottom ? LOWER : BLANK
      words[at + 1] = isHead ? glint : ink
      words[at + 2] = DEFAULT
    }
  }

  return base64(new Uint8Array(words.buffer))
}

export const BAND_ROWS = ROWS

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64; the module has no `btoa` it can count on. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const at = (n: number) => ALPHABET[n & 63]!
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += at(n >> 18) + at(n >> 12) + at(n >> 6) + at(n)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += at(n >> 18) + at(n >> 12) + '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += at(n >> 18) + at(n >> 12) + at(n >> 6) + '='
  }

  return out
}
