# Laika Orbit — operating manual

This knowledge base is read by an agent, not by a person browsing folders. Routing beats hierarchy.

## Layout

- `routers/` — typed pointer playbooks, one per department. **These are the index.** Keep them current.
- `raw/` — dumping ground. Messy by design. Nothing reads it directly.
- `wiki/` — `index.md`, `log.md`, `processed.md` only. No content pages.
- `outputs/` — generated artefacts.

## Router file format

Pointer lines are typed and machine-parsed by `@laika/core`:

- `Skills:` a capability to invoke
- `Files:` a concrete file or glob
- `Reference:` background material
- `Thinking:` principles and canonical notes
- `Rules:` hard constraints

`- <Type>: <path> — <one-line description>` grouped under `## <stage>` headings.
The description is scored, so write it for retrieval, not for prose.

## Departments

- Reference: brain/routers/ENGINEERING.md — the Laika Orbit build itself
- Reference: brain/routers/CONTENT.md — research, video, publishing
- Reference: brain/routers/CLIENTS.md — client engagements
