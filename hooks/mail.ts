// Messages between sessions as Claude Code delivers them: who sent one, read
// off the envelope it arrives in, and the line the band shows for it.

/** An inbox as the envelope spells it (`uds:/tmp/…`) or as the session's env does. */
export const bareInbox = (address: string) => address.trim().replace(/^uds:/, '')

/** The sender's inbox and session name, from the envelope around a message. */
export function readEnvelope(text: string): { from: string | null; name: string | null } {
  const tag = /<cross-session-message\b([^>]*)>/.exec(text)?.[1] ?? ''
  const attribute = (key: string) => new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(tag)?.[1] || null
  const from = attribute('from')

  return { from: from ? bareInbox(from) : null, name: attribute('from-name') }
}

/** The message's first line of its own words, for the band. */
export function preview(text: string): string {
  const line = text
    .replace(/<[^>]*>/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)

  return (line ?? '').slice(0, 160)
}
