import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { TotemIdentity, TotemPeer, TotemView } from '../types'
import { chooseHue, hex, hueDistance, oklch, palette, parseHex, toOklch } from '../hooks/color'
import { canDraw, measure, rasterize, spell } from '../hooks/font'
import { settleEmoji, slug } from '../hooks/identity'
import { byUrgency } from '../hooks/radar'

const DAISY: TotemIdentity = {
  key: '/work/daisyui',
  name: 'daisyui',
  emoji: '🌼',
  hue: 95,
  chroma: 1,
  source: 'auto',
}

const VIEW: TotemView = {
  identity: DAISY,
  isForging: false,
  isLight: false,
  path: '~/work/daisyui',
  branch: 'main',
  isWorktree: false,
  hasArrived: true,
}

const peer = (over: Partial<TotemPeer>): TotemPeer => ({
  id: 'ttys014',
  key: '/work/orbit',
  name: 'orbit',
  emoji: '🪐',
  hue: 290,
  chroma: 1,
  tty: '/dev/ttys014',
  program: 'Apple_Terminal',
  pane: null,
  state: 'idle',
  since: 1_000,
  seenAt: 2_000,
  cwd: '~/work/orbit',
  branch: 'main',
  ...over,
})

const SHAPES = { view: 'view-1', status: 'status-1', peers: 'peers-1' } as const

/** Answers totem's state reads with these values, as a session that holds them would. */
function seed(
  on: Parameters<TestBody>[1],
  values: { view: TotemView; status?: { state: TotemPeer['state']; since: number }; peers?: TotemPeer[] },
) {
  const all = {
    view: values.view,
    status: values.status ?? { state: 'working', since: 0 },
    peers: values.peers ?? [],
  }
  on('state.get', (_, e) => {
    const key = e.key as keyof typeof SHAPES
    return { value: { value: { shape: SHAPES[key], value: all[key] }, version: 1 } }
  })
  // Nothing sits beneath the plugin in a test: these stand for the engine.
  on('clock.now', () => ({ value: 65_000 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const band = (bodyColumns: number, over: { hasSurvey?: boolean; maxRows?: number } = {}) =>
  ({
    plugin: 'totem',
    component: 'AbovePrompt',
    props: {
      hasSurvey: over.hasSurvey ?? false,
      isWorking: false,
      maxRows: over.maxRows ?? 12,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  }) as const

describe('the band', () => {
  test('spells the project big, with its state and the other sessions', async ($, on) => {
    seed(on, { view: VIEW, peers: [peer({ state: 'needs' })] })
    const ui = await $.ui.mount({ ...band(140), surface: 'terminal' })

    expect(await ui.find({ type: 'Raster', key: 'totem-name' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🌼 daisyui/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /working/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1m/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'peer-ttys014' })).toBeDefined()
    await ui.unmount()
  })

  test('falls back to one bar where the big letters do not fit', async ($, on) => {
    seed(on, { view: VIEW })
    const ui = await $.ui.mount({ ...band(30), surface: 'terminal' })

    expect(await ui.find({ type: 'Raster', key: 'totem-name' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /DAISYUI/ })).toBeDefined()
    await ui.unmount()
  })

  // The band is raised on the terminal and the desktop app only.
  test('draws the bar on the desktop, which has no Raster', async ($, on) => {
    seed(on, { view: VIEW })
    const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })

    expect(await ui.find({ type: 'Text', text: /DAISYUI/ })).toBeDefined()
    await ui.unmount()
  })

  test('says it is forging while a new project gets its totem', async ($, on) => {
    seed(on, { view: { ...VIEW, identity: null, isForging: true } })
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /forging a totem for/ })).toBeDefined()
    await ui.unmount()
  })

  test('steps aside for a survey', async ($, on) => {
    seed(on, { view: VIEW })
    const ui = await $.ui.mount({ ...band(120, { hasSurvey: true }), surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /daisyui/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
    await ui.unmount()
  })

  test('shows two others and a count when more are live than rows', async ($, on) => {
    const many = ['a', 'b', 'c', 'd'].map((name, i) => peer({ id: `t${i}`, name }))
    seed(on, { view: VIEW, peers: many })
    const ui = await $.ui.mount({ ...band(150), surface: 'terminal' })

    expect(await ui.find({ type: 'Button', key: 'peer-t0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'peer-t1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'peer-t2' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'peers-more' })).toBeDefined()
    await ui.unmount()
  })
})

describe('color', () => {
  test('a hex color keeps its hue through OKLCH', () => {
    for (const color of ['#7c3aed', '#16a34a', '#0ea5e9']) {
      const back = toOklch(parseHex(color)!)
      expect(hex(oklch(back.L, back.C, back.hue))).toBe(color)
    }
  })

  test('every tint is dark on dark themes and light on light ones', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      const dark = toOklch(palette(hue, false).tint)
      const light = toOklch(palette(hue, true).tint)
      expect(dark.L).toBeLessThan(0.25)
      expect(light.L).toBeGreaterThan(0.95)
    }
  })

  test('hues chosen for open projects stay apart', () => {
    const taken: number[] = []
    for (const wish of [10, 12, 14, 200, 205, 330]) taken.push(chooseHue(wish, taken))
    for (let i = 0; i < taken.length; i++) {
      for (let j = i + 1; j < taken.length; j++) {
        expect(hueDistance(taken[i]!, taken[j]!)).toBeGreaterThan(29)
      }
    }
  })

  test('a free hue is kept as wished', () => {
    expect(chooseHue(95, [245, 25])).toBe(95)
  })

  test('closed projects only ask for half the room open ones do', () => {
    // 25° from a closed project is fine; from an open one it is too close.
    expect(chooseHue(50, [], [25, 95])).toBe(50)
    expect(hueDistance(chooseHue(50, [25]), 25)).toBeGreaterThan(39)
  })
})

describe('font and names', () => {
  test('a name is drawn 3 rows tall and as wide as it measures', () => {
    const grid = rasterize(spell('daisyui'))
    expect(grid.length).toBe(6)
    expect(grid[0]?.length).toBe(measure('DAISYUI'))
  })

  test('accents fold and unknown letters are refused', () => {
    expect(spell('Café Ünïcode')).toBe('CAFE UNICODE')
    expect(canDraw(spell('اشبيليا'))).toBe(false)
  })

  test('an emoji is one character or nothing', () => {
    expect(settleEmoji('🌼')).toBe('🌼')
    expect(settleEmoji('👩‍💻')).toBeNull()
    expect(settleEmoji('hi')).toBeNull()
  })

  test('slugs are stable and safe', () => {
    expect(slug('/a/My Project')).toBe(slug('/a/My Project'))
    expect(slug('/a/My Project')).toMatch(/^my-project-[0-9a-f]{8}$/)
  })

  test('the radar puts whoever needs you first', () => {
    const list = [peer({ id: 'w', state: 'working' }), peer({ id: 'n', state: 'needs' }), peer({ id: 'd', state: 'done' })]
    expect([...list].sort(byUrgency).map(p => p.id)).toEqual(['n', 'd', 'w'])
  })
})
