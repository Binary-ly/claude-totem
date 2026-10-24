# Contributing to totem

Thanks for helping. totem is small on purpose: a handful of files, no dependencies, no build step. Claude Code loads the TypeScript in `hooks/` as it is.

## The loop

1. Fork and clone, then start a session from the clone: `claude --plugin-dir /path/to/claude-totem`. Every save hot-reloads the mod in that session; a hook that fails says so in a dim line in the transcript.
2. Open two or three more sessions the same way in other folders to see the radar and the colors side by side.
3. `claude plugin test .` and `claude plugin validate .` before you push. Once a session has loaded the folder, `tsc -p .` type-checks against `.claude-plugin/types/` (which the engine writes and git ignores).

The engine's own reference for the API is the `.d.ts` it lays in `.claude-plugin/types/claude-code/index.d.ts`. Grep it for the event or noun you need (`'ui.render'`, `RasterProps`, `$.process.run`).

## Where things live

- `hooks/register.tsx` wires the events and holds the session's runtime. The engine traces `$` statically, so a helper that takes `$` must be a top-level function of its file (or imported from another file of the mod), never a closure inside `register`.
- `hooks/identity.ts` decides a project's name, emoji and hue. The order is: your own pick, then the team's `.claude/totem.json`, then what is saved, then a new totem.
- `hooks/color.ts` is pure: OKLCH conversion, palettes, `chooseHue`. Tests cover it.
- `hooks/font.ts` is the pixel font. Each glyph is 5 rows of `#` and `.`; widths can differ. Add a glyph and it is drawable.
- `hooks/terminal.ts` talks to the terminal: the tty, OSC sequences, and `focus()` for jumping to another tab.
- `hooks/radar.ts` reads and writes `~/.claude/totem/live/`.
- `hooks/draw.tsx` builds the trees. It gets everything it draws as input, so it stays easy to test.

## What would help most

- **Jumping in more terminals.** `focus()` in `terminal.ts` has untested branches for iTerm2, WezTerm, kitty and tmux, and nothing for Ghostty or Windows Terminal. If you use one, try `/totem jump <project>` and tell us, or fix it.
- **tmux.** Does OSC 11 reach the outer terminal, and should the tint go through `select-pane -P` instead?
- **Light themes.** The light palette is computed but barely looked at.
- **More of the font.** Lowercase, more punctuation, and a fallback for names the font cannot spell (today those get the one-line bar).
- **Seeing when you look.** `✓ your turn` clears when you start typing; clearing it when you switch to the tab would be better. Terminals report focus, but the mod API does not pass it on yet.

## Style

Match the code around you: small top-level functions, comments that say why, names that read as words. Keep the module free of dependencies; the hooks environment has no Node and no DOM.

Commits are one sentence. Open an issue first for anything large.
