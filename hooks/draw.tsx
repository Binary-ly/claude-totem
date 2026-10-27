// The trees totem draws: the band above the prompt (big or bar) and the pane
// /totem opens. Pure: what to draw comes in, the element table included.

import type { Color, Elements } from 'claude-code'

import type { TotemIdentity, TotemMail, TotemPeer, TotemState, TotemView } from '../types'
import { hex, palette } from './color'
import { BAND_ROWS, spell } from './font'
import { GLYPH, LABEL, age } from './radar'

type Common = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Table = Common & { Raster?: Elements['terminal']['Raster'] }

export const NAME_KEY = 'totem-name'

export const STATE_COLOR: Record<TotemState, Color> = {
  needs: 'warning',
  done: 'success',
  working: 'claude',
  idle: 'inactive',
}

export type Word = { cells: string; width: number }

export type BandInput = {
  el: Table
  columns: number
  maxRows: number
  style: 'big' | 'bar'
  view: TotemView
  identity: TotemIdentity
  state: TotemState
  since: number
  now: number
  peers: readonly TotemPeer[]
  /** The latest message in or out, while it is fresh. */
  mail: TotemMail | null
  /** The name in pixel letters, when it can be drawn that way. */
  word: Word | null
  onJump: (peer: TotemPeer) => void
  onMore: () => void
}

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** The other side of a message in its own ink, or dim when the radar doesn't know it. */
function MailWho(el: Table, mail: TotemMail, isLight: boolean) {
  const { Text } = el
  const who = `${mail.emoji ? `${mail.emoji} ` : ''}${mail.name}`

  return mail.hue === null ? (
    <Text dimColor>{who}</Text>
  ) : (
    <Text color={hex(palette(mail.hue, isLight, mail.chroma).ink)} bold>
      {who}
    </Text>
  )
}

function MailLine(el: Table, mail: TotemMail, isLight: boolean) {
  const { Text } = el

  return (
    <Text wrap="truncate-end">
      <Text color="claude">{mail.way === 'in' ? '✉ ' : '✉ to '}</Text>
      {MailWho(el, mail, isLight)}
      <Text dimColor>
        {mail.way === 'in' ? ': ' : ' · '}
        {mail.text}
      </Text>
    </Text>
  )
}

function PeerChip(el: Table, peer: TotemPeer, index: number, isLight: boolean, onJump: (p: TotemPeer) => void) {
  const { Button, Text } = el
  const ink = hex(palette(peer.hue, isLight, peer.chroma).ink)

  return (
    <Button key={`peer-${peer.id}`} plain hotkey={String(index + 1)} onPress={() => onJump(peer)}>
      <Text color={STATE_COLOR[peer.state]}>{GLYPH[peer.state]} </Text>
      <Text color={ink}>
        {peer.emoji} {short(peer.name, 18)}
      </Text>
    </Button>
  )
}

function peerColumn(input: BandInput, room: number) {
  const { el, peers, view, onJump, onMore } = input
  const { Button, Text } = el
  if (peers.length === 0) return null
  const shown = peers.length > room ? peers.slice(0, room - 1) : peers.slice(0, room)
  const rest = peers.length - shown.length

  return [
    ...shown.map((peer, i) => PeerChip(el, peer, i, view.isLight, onJump)),
    rest > 0 ? (
      <Button key="peers-more" plain hotkey={String(shown.length + 1)} onPress={onMore}>
        <Text dimColor>+{rest} more · /totem</Text>
      </Button>
    ) : null,
  ]
}

export function Forging(el: Table, name: string) {
  const { Box, Text } = el

  return (
    <Box marginLeft={2}>
      <Text color="claude">✦ </Text>
      <Text dimColor>forging a totem for </Text>
      <Text bold>{name}</Text>
      <Text dimColor>…</Text>
    </Box>
  )
}

export function Band(input: BandInput) {
  const { el, columns, maxRows, word } = input
  const canBeBig =
    input.style === 'big' && !!el.Raster && !!word && maxRows >= BAND_ROWS && word.width + 4 <= columns

  return canBeBig ? Big(input, word) : Bar(input)
}

function Big(input: BandInput, word: Word) {
  const { el, columns, identity, view, state, since, now } = input
  const { Box, Text } = el
  const Raster = el.Raster!
  const colors = palette(identity.hue, view.isLight, identity.chroma)
  const ink = hex(colors.ink)
  const soft = hex(colors.soft)
  const left = 2 + word.width + 3
  const peerWidth = input.peers.length > 0 ? 26 : 0
  const middle = columns - left - peerWidth
  const peers = middle >= 0 || peerWidth === 0 ? peerColumn(input, BAND_ROWS) : null

  return (
    <Box flexDirection="row" width={columns}>
      <Box marginLeft={2} marginRight={3} flexShrink={0}>
        <Raster key={NAME_KEY} columns={word.width} rows={BAND_ROWS} cells={word.cells} />
      </Box>
      {middle >= 20 && (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={ink} bold>
              {identity.emoji} {identity.name}
            </Text>
            {view.branch ? (
              <Text color={soft}>
                {'  ⑂ '}
                {view.branch}
                {view.isWorktree ? ' (worktree)' : ''}
              </Text>
            ) : null}
          </Text>
          {input.mail ? (
            MailLine(el, input.mail, view.isLight)
          ) : (
            <Text color={soft} wrap="truncate-start">
              {view.path}
            </Text>
          )}
          <Text wrap="truncate-end">
            <Text color={STATE_COLOR[state]}>
              {GLYPH[state]} {LABEL[state]}
            </Text>
            <Text dimColor>
              {' · '}
              {age(now - since)}
            </Text>
          </Text>
        </Box>
      )}
      {peers ? (
        <Box flexDirection="column" flexShrink={0} alignItems="flex-end" marginLeft={2}>
          {peers}
        </Box>
      ) : null}
    </Box>
  )
}

function Bar(input: BandInput) {
  const { el, columns, identity, view, state } = input
  const { Box, Text } = el
  const colors = palette(identity.hue, view.isLight, identity.chroma)
  const deep = hex(colors.deep)
  const ink = hex(view.isLight ? colors.ink : colors.glint)
  const soft = hex(colors.soft)
  const peers = input.peers.length > 0 && columns >= 90 ? peerColumn(input, 3) : null

  return (
    <Box flexDirection="row" width={columns}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} backgroundColor={deep}>
        <Text backgroundColor={deep} color={ink} bold>
          {' '}
          {identity.emoji} {spell(identity.name)}{' '}
        </Text>
        <Text backgroundColor={deep} color={soft} wrap="truncate-start">
          {view.branch ? ` ⑂ ${view.branch} ` : ' '}
          {view.path}{' '}
        </Text>
        <Box flexGrow={1} />
        {input.mail ? (
          <Text backgroundColor={deep} wrap="truncate-end">
            <Text backgroundColor={deep} color="claude">
              {input.mail.way === 'in' ? ' ✉ ' : ' ✉ to '}
            </Text>
            {MailWho(el, input.mail, view.isLight)}
          </Text>
        ) : null}
        <Text backgroundColor={deep} color={STATE_COLOR[state]}>
          {' '}
          {GLYPH[state]} {LABEL[state]}{' '}
        </Text>
      </Box>
      {peers ? (
        <Box flexDirection="row" flexShrink={0} gap={2} marginLeft={2}>
          {peers}
        </Box>
      ) : null}
    </Box>
  )
}

export type PaneInput = {
  el: Table
  columns: number
  view: TotemView
  identity: TotemIdentity
  state: TotemState
  since: number
  now: number
  peers: readonly TotemPeer[]
  /** Messages in and out, newest first. */
  mail: readonly TotemMail[]
  word: Word | null
  onJump: (peer: TotemPeer) => void
}

export function Pane(input: PaneInput) {
  const { el, view, identity, state, since, now, peers, mail, word, onJump } = input
  const { Box, Text, Button } = el
  const colors = palette(identity.hue, view.isLight, identity.chroma)
  const ink = hex(colors.ink)
  const soft = hex(colors.soft)
  const Raster = el.Raster
  const fits = !!Raster && !!word && word.width + 2 <= input.columns
  const from =
    identity.source === 'team'
      ? 'from the team’s .claude/totem.json'
      : identity.source === 'user'
        ? 'your pick'
        : 'forged for this project'

  return (
    <Box flexDirection="column">
      {fits ? (
        <Box marginBottom={1}>
          <Raster key="pane-name" columns={word.width} rows={BAND_ROWS} cells={word.cells} />
        </Box>
      ) : (
        <Text color={ink} bold>
          {identity.emoji} {spell(identity.name)}
        </Text>
      )}
      <Text>
        <Text color={ink} bold>
          {identity.emoji} {identity.name}
        </Text>
        <Text color={soft}>
          {'  hue '}
          {identity.hue}° · {from}
        </Text>
      </Text>
      <Text color={soft} wrap="truncate-start">
        {view.path}
        {view.branch ? `  ⑂ ${view.branch}` : ''}
      </Text>
      <Text>
        <Text color={STATE_COLOR[state]}>
          {GLYPH[state]} {LABEL[state]}
        </Text>
        <Text dimColor> · {age(now - since)}</Text>
      </Text>
      <Box marginTop={1}>
        <Text bold>Other sessions</Text>
        <Text dimColor>{peers.length > 0 ? '  · press one to jump to its tab' : ''}</Text>
      </Box>
      {peers.length === 0 && <Text dimColor>None live. Open Claude Code in another project and it shows up here.</Text>}
      {peers.map((peer, i) => {
        const peerInk = hex(palette(peer.hue, view.isLight, peer.chroma).ink)
        return (
          <Button key={`row-${peer.id}`} plain hotkey={i < 9 ? String(i + 1) : undefined} onPress={() => onJump(peer)}>
            <Text color={STATE_COLOR[peer.state]}>{GLYPH[peer.state]} </Text>
            <Text color={peerInk} bold>
              {peer.emoji} {short(peer.name, 24)}
            </Text>
            <Text dimColor>
              {'  '}
              {LABEL[peer.state]} · {age(now - peer.since)}
              {peer.branch ? `  ⑂ ${short(peer.branch, 28)}` : ''}
            </Text>
          </Button>
        )
      })}
      {mail.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Messages</Text>
          {mail.slice(0, 5).map((m, i) => (
            <Text key={`mail-${m.at}-${i}`} wrap="truncate-end">
              <Text dimColor>{m.way === 'in' ? '← ' : '→ '}</Text>
              {MailWho(el, m, view.isLight)}
              <Text dimColor>
                {' · '}
                {age(now - m.at)}
                {'  '}
                {m.text}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>/totem color #7c3aed · 210 · next</Text>
        <Text dimColor>/totem emoji 🦊 · /totem name Daisy UI</Text>
        <Text dimColor>/totem share   commit it so the team matches</Text>
        <Text dimColor>/totem reroll · /totem doctor · /totem setup</Text>
      </Box>
    </Box>
  )
}
