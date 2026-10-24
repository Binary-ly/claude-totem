// Color in OKLCH, so every project's tint sits at the same perceived lightness
// and only the hue tells them apart. Conversions after Björn Ottosson's OKLab.

export type Rgb = { r: number; g: number; b: number }

export type Palette = {
  /** The terminal's background while the session runs. */
  tint: Rgb
  /** The big name and the project's own text. */
  ink: Rgb
  /** The scan head of the reveal and the sweep. */
  glint: Rgb
  /** The bar style's background. */
  deep: Rgb
  /** Secondary text in the project's hue. */
  soft: Rgb
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const toGamma = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const inGamut = (c: [number, number, number]) =>
  c.every(v => v >= -0.0001 && v <= 1.0001)

const channel = (v: number) =>
  Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255)

/** An OKLCH color as sRGB, its chroma reduced until it fits the gamut. */
export function oklch(L: number, C: number, hue: number): Rgb {
  const rad = (hue * Math.PI) / 180
  const at = (c: number) => labToLinear(L, c * Math.cos(rad), c * Math.sin(rad))
  let low = 0
  let high = C

  if (!inGamut(at(C))) {
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2
      if (inGamut(at(mid))) low = mid
      else high = mid
    }
  } else {
    low = C
  }
  const [r, g, b] = at(low)

  return { r: channel(r), g: channel(g), b: channel(b) }
}

export function toOklch(rgb: Rgb): { L: number; C: number; hue: number } {
  const [L, a, b] = linearToLab(
    toLinear(rgb.r / 255),
    toLinear(rgb.g / 255),
    toLinear(rgb.b / 255),
  )
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360

  return { L, C: Math.hypot(a, b), hue }
}

export function hex(rgb: Rgb): string {
  const two = (v: number) => v.toString(16).padStart(2, '0')

  return `#${two(rgb.r)}${two(rgb.g)}${two(rgb.b)}`
}

export function parseHex(text: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!m || !m[1]) return null
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]

  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

/** `0x00RRGGBB`, as a Raster cell takes it. */
export const packed = (rgb: Rgb) => (rgb.r << 16) | (rgb.g << 8) | rgb.b

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  return (
    0.2126 * toLinear(rgb.r / 255) +
    0.7152 * toLinear(rgb.g / 255) +
    0.0722 * toLinear(rgb.b / 255)
  )
}

/** A step from `a` to `b`, `t` of the way, mixed in OKLab. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const la = linearToLab(toLinear(a.r / 255), toLinear(a.g / 255), toLinear(a.b / 255))
  const lb = linearToLab(toLinear(b.r / 255), toLinear(b.g / 255), toLinear(b.b / 255))
  const [L, A, B] = la.map((v, i) => v + ((lb[i] ?? v) - v) * t) as [number, number, number]
  const [r, g, bl] = labToLinear(L, A, B)

  return { r: channel(r), g: channel(g), b: channel(bl) }
}

export function palette(hue: number, isLight: boolean, chroma = 1): Palette {
  const c = (n: number) => n * Math.max(0, Math.min(1, chroma))

  return isLight
    ? {
        tint: oklch(0.972, c(0.022), hue),
        ink: oklch(0.5, c(0.16), hue),
        glint: oklch(0.72, c(0.2), hue),
        deep: oklch(0.88, c(0.07), hue),
        soft: oklch(0.55, c(0.08), hue),
      }
    : {
        tint: oklch(0.215, c(0.045), hue),
        ink: oklch(0.8, c(0.14), hue),
        glint: oklch(0.96, c(0.05), hue),
        deep: oklch(0.36, c(0.09), hue),
        soft: oklch(0.68, c(0.07), hue),
      }
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360

  return d > 180 ? 360 - d : d
}

/**
 * The hue closest to `preferred` that stays clear of the others, so projects
 * you have open at the same time never look alike.
 *
 * `open` are the hues of sessions live now: they get the full room, 40° at
 * first and less as the wheel fills. `recent` are projects opened lately but
 * closed: half that room is enough, so a project keeps the color that suits
 * it unless it would be mistaken for one you use. Past all that, the middle
 * of the widest gap.
 */
export function chooseHue(
  preferred: number,
  open: readonly number[],
  recent: readonly number[] = [],
): number {
  const wish = ((Math.round(preferred) % 360) + 360) % 360
  if (open.length === 0 && recent.length === 0) return wish
  const room = (h: number, from: readonly number[]) =>
    from.length === 0 ? 180 : Math.min(...from.map(t => hueDistance(h, t)))
  const fits = (h: number, need: number) => room(h, open) >= need && room(h, recent) >= need / 2

  for (const need of [40, 30, 22, 15]) {
    if (fits(wish, need)) return wish
    let best = -1
    let bestDistance = Infinity
    for (let h = 0; h < 360; h += 2) {
      const d = hueDistance(h, wish)
      if (fits(h, need) && d < bestDistance) {
        best = h
        bestDistance = d
      }
    }
    if (best >= 0) return best
  }
  let widest = wish
  let widestRoom = -1
  for (let h = 0; h < 360; h += 2) {
    const r = Math.min(room(h, open), room(h, recent) * 2)
    if (r > widestRoom) {
      widest = h
      widestRoom = r
    }
  }

  return widest
}

/**
 * FNV-1a, 32 bits, then murmur3's finalizer: a stable number for a path, with
 * paths that differ in one letter landing far apart.
 */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16

  return h >>> 0
}
