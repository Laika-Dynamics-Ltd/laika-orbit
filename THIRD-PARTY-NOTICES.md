# Third-party notices

Laika Orbit's own code is MIT-licensed (see [LICENSE](LICENSE)). It depends on the packages
below, installed from npm under their own licences. None is copied into this repository.

## Licences that ask more than MIT

| Package | Used by | Licence | What it means |
|---|---|---|---|
| [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | `app` (Claude chats) | Proprietary, © Anthropic PBC | Use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance). It is installed from npm, never bundled here, and each user signs in with their own Claude account through Claude Code's own login. |
| [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell) | `shell` (Chrome extensions) | GPL-3.0, or a paid Patron licence | This repository selects the GPL-3.0 option. The source is MIT and GPL-compatible, but **a built desktop app that includes this package must be distributed under GPL-3.0** with its full source, unless the distributor holds a Patron licence. |
| [`ical.js`](https://github.com/kewisch/ical.js) | `app` (calendar widget) | MPL-2.0 | Used unmodified. Its source is at the link. |

## Permissive

`three` (MIT), `troika-three-text` (MIT), `@xterm/xterm` and addons (MIT), `node-pty` (MIT),
`vite` (MIT), `electron` (MIT, with Chromium's licences in `LICENSES.chromium.html` in any
built app), `electron-chrome-web-store` (MIT), `@modelcontextprotocol/sdk` (MIT), `zod` (MIT),
`camera-controls` (MIT), `postprocessing` (Zlib).

Build and test only: `typescript` and `playwright` (Apache-2.0), `vitest` (MIT),
`@biomejs/biome` (MIT or Apache-2.0), `lightningcss` (MPL-2.0).

`pnpm licenses list` prints the full tree.

## Research credits

`research/notes/findings.md` summarises public videos by Jay E / RoboNuggets on the "Rubric"
second brain, which Laika Orbit's design started from and departs from in four places.
