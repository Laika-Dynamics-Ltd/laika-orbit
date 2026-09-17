# 1brain

**Zero-model recall over your files.** Ask a question, get back the exact section that answers it
and the file it came from, in about a millisecond, without calling a model. Built for Claude Code:
as an MCP server it replaces grep-and-read-whole-files with one call, using far fewer tokens.

1brain is the engine inside [Laika Orbit](https://github.com/Laika-Dynamics-Ltd/laika-orbit).

## Use it with Claude Code

```bash
claude mcp add 1brain -- npx -y 1brain mcp
```

Claude Code starts the server in your project folder and gets three tools: `recall` (answer a
question with the matching section and its source), `get` (read a file) and `status`. To point it
at another folder, add `--root <dir>` after `mcp`.

## Use it from the terminal

```bash
npx 1brain index                          # build the index for this folder
npx 1brain recall "how do we roll back a deploy"
npx 1brain lint                           # check router files for dangling pointers
npx 1brain ask "…"                        # print the packed prompt for a model
```

Every command takes `--root <dir>`; otherwise the corpus is `BRAIN_ROOT`, then the working directory.

## How it finds the answer

Seven steps, none of them a model call: tokenise the question on word boundaries, score it against
an inverted index, keep the top five with a confidence margin, open only the winner, slice out the
matching `##` section, follow at most one pointer, and pack the result.

It works on any folder of Markdown and text. It works best with **router files**: short typed
pointer lists in `brain/routers/*.md` that say where things are, written the way questions are
asked:

```markdown
## 1 — deploys

- Files: notes/deploy.md — how production deploys are rolled back
- Rules: notes/freeze.md — no deploys on Fridays after 2pm
```

Which folders are indexed, and how, is set in `brain/index.config.json` (optional). `.docx`, `.rtf`
and `.odt` are read with macOS `textutil`, and PDFs with `pdftotext` when it's installed.

## Requirements

Node 22 or newer. Nothing leaves your machine: 1brain reads local files and makes no network calls.

## Licence

MIT © Laika Dynamics Limited
