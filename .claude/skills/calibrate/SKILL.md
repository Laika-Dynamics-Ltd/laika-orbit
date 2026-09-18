---
name: calibrate
description: At the end of a working session, analyse what actually happened and propose edits to the router files, skills and rules so the knowledge base gets better at the next one. Proposes a diff — never writes unattended. Triggers on "calibrate", "capture what we learned", "update the brain", "/calibrate".
---

# Calibrate

The mechanism that makes the second brain self-improving. Without it, router files rot: the index
describes the workspace as it was on the day someone last hand-edited it, and recall quality decays
quietly because bag-of-words scoring is only as good as the descriptions it scores.

This is the **I** and **T** of Build → Integrate → Tune.

## When to run

At the end of a session in which any of these happened:

- you corrected the agent on something it should have known
- a `laikaorbit recall` returned the wrong file, or the right file with a low margin
- a new file, skill or rule was created that nothing points at
- a decision was made that isn't written down anywhere

## What to do

**1. Find what the brain got wrong.** Re-run the questions this session should have been able to
answer:

```bash
node packages/cli/src/index.ts recall "<question the session raised>"
```

Look for: wrong top candidate, margin under 25%, `no match`, or the right file reached only via a
lucky filename match rather than a description.

**2. Find what the brain can't see.**

```bash
node packages/cli/src/index.ts lint      # dangling pointers, malformed lines
node packages/cli/src/index.ts index     # doc count vs pointer count
```

A file that exists but no router points at is invisible to scoring except by filename.

**3. Propose edits as a diff.** For each problem, the smallest change that fixes it:

- a missing pointer → add one typed line under the right stage
- a vague description → rewrite it *for retrieval*, using the words someone would actually ask with
- a wrong-file result → usually a missing `Reference:` or a topic-map entry, not a scoring bug
- a repeated correction → a new `Rules:` file in `brain/rules/`, pointed at from the router

**4. Show the diff and stop.** Do not apply it. Print each proposed change as:

```
brain/routers/<X>.md  (+N pointers)
  + Skills: <path> — <description written for retrieval>
  ~ Files: <path> — <old description>
             → <better description, using the words people ask with>
```

Then ask which to apply. **Never write to `brain/` unattended.**

## Why it proposes rather than writes

The router files are the index. A bad automated edit degrades every future recall silently, and the
failure looks exactly like the system working. Cheap to review, expensive to get wrong — so a human
sees the diff.

## Rules

- Descriptions are scored text. Write them the way a question is phrased, not the way a filename reads.
- One pointer per real thing. A router is a playbook, not a directory listing.
- Never delete a pointer to make lint pass — fix the path or the file.
- If a recall was wrong and no edit would have fixed it, say so. That's a scoring-model limitation
  and it belongs in `bench/RESULTS.md`, not papered over in a router file.
