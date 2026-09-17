# Hyperframes — Research Notes

Source: **Hyperframes V2** (`4E2I_NJkzhI`, 19:59) + the **open-source helper kit**.
Frames: `research/frames/hf_*.jpg` · contact sheet: `research/screenshots/contact-hf.jpg`
Cloned repo: `research/hyperframes-helper/`

## What Hyperframes actually is

**HeyGen's open-source HTML-to-MP4 renderer.** Apache 2.0, fully local, **no HeyGen API key needed**.
You write HTML/CSS/GSAP; it renders deterministically to MP4.

> "The output looks like motion graphics; the source is just a webpage. That makes it agent-native —
> LLMs can write it first try, no React/Remotion bundler dance."

- Repo: https://github.com/heygen-com/hyperframes · Docs: https://hyperframes.heygen.com
- Needs only Node 18+. First render pulls Chrome (~101MB), cached after.

```bash
npx hyperframes@latest init my-video
npx skills add heygen-com/hyperframes      # /hyperframes, /gsap, /website-to-hyperframes
npx hyperframes@latest preview             # Studio at localhost:3002
npx hyperframes@latest lint
npx hyperframes@latest render -o out.mp4 --fps 30 --quality high --crf 16 --gpu
```

## The RoboNuggets helper kit — MIT-adjacent, CC BY 4.0, public

`github.com/robonuggets/hyperframes-helper`. Small and entirely readable:

```
.claude/skills/hyperframes-helper/
├── SKILL.md                      # 20K — workflow + 16 lint gotchas
└── templates/
    ├── composition-template.html
    ├── storyboard-template.html
    ├── recipes.md                # 11 copy-paste motion-graphics patterns
    ├── silence-cut.sh
    ├── transcribe-whisper.py
    └── cut-retakes.py
```

This is the **best concrete example of the "rich reference skill"** pattern from the ARMS video —
SKILL.md is a router, the real payload is in `templates/`.

## Three levels

| Level | What | Cost |
|---|---|---|
| **1 · Website-to-video** | Point `/website-to-hyperframes` at a URL → 6–15s MP4 | One prompt. Good draft, sloppy typography. |
| **2 · Storyboards** | Plan layout in a **storyboard HTML** before building the real composition | ~1 min/iteration vs ~15 min in Studio. The key unlock. |
| **3 · Guided videos** | Talking-head + motion graphics, full pipeline | Heavily guided. Many prompts. |

## The Level 3 pipeline (the useful part)

```
STEP 01 Cut the video → STEP 02 Storyboard title cards → STEP 03 Add motion graphics
```

**Step 01** — three passes, all ffmpeg + whisper, no paid tools:
- **A. Silence cut:** `ffmpeg -af "silencedetect=noise=-30dB:d=0.4"`, build keep-ranges with 0.04s pad,
  re-encode with **1s GOP** keyframes (Hyperframes needs tight keyframes for frame seek).
- **B. Transcribe:** `faster-whisper` → word-level timestamps.
  *(Chose faster-whisper over WhisperX because torchaudio is fragile on Windows — CTranslate2, no torch.)*
- **C. Retake cut:** **last-take rule** — phrase said twice, keep the second, cut the first.
- **Ship a `script-review.html`**: current vs proposed script side by side, retakes struck through red,
  last-takes green, numbered cut table. Reviewers approve before any re-encode. *(76s → 30s in his demo.)*

**Step 02** — storyboard HTML showing scene count, per-scene seconds, mock layout and copy. Give feedback
on the storyboard, not on a rendered video. This is where the token/time saving is.

**Step 03** — centre-stage motion graphics per beat: shader flashes, D3 `geoOrthographic` wireframe globe,
chroma-keyed 3D logo (green screen keyed via SVG `feColorMatrix`), logo assemblies, closing text.

**Asset sourcing trick:** since Hyperframes is just HTML, **21st.dev** components work directly —
copy the component prompt, paste into Claude Code, tell it which beat to apply it to. CodePen too.

## The 16 lint gotchas — the real IP

These are hard-won and would each cost an hour to rediscover. Highlights:

1. Every timed element needs `class="clip"` + `data-start` + `data-duration` + `data-track-index`.
2. **GSAP must not animate clip elements** — the framework owns clip visibility. Wrap in an outer
   clip-shell + inner animatable div.
3. **Clips on one track cannot overlap, even by 0.001s.** Float precision bites: `start=23.85, duration=4.55`
   ends at `28.400000002` and collides with `start=28.40`.
4. Visually-overlapping elements → separate tracks (4 cards visible together = tracks 12/13/14/15).
5. GSAP timeline must be `paused: true` and registered on `window.__timelines[id]`.
6. **Deterministic only** — no `Math.random()`, `Date.now()`, `fetch()`. Render is frame-by-frame seek.
7. Video must be `muted` with a separate `<audio>` element.
8. Source needs 1s GOP keyframes.
9. Canvas animations redraw on `tl.eventCallback('onUpdate', ...)`, never `requestAnimationFrame`.
11. **`repeat: -1` is forbidden** — derive a finite count: `Math.floor(HOLD / CYCLE) - 1`.
12. Two `<audio>` with the same `src` = echo. One pre-cut audio clip only.
13. `::before`/`::after` can't be GSAP'd — use real child divs.
14–16. z-index traps: Studio writes inverted inline z-indexes (bulk-strip with regex);
    `z-index: -1` hides an element behind the body paint — use DOM order instead.

**Studio limits:** can drag horizontally, between rows, right handle (end-trim), left handle on *media*
clips (front-trim). **Cannot** split clips mid-source, no keyboard shortcuts, no multi-select, **no undo**.
Workaround for splitting: keep the uncut source and define several `<video>` clips with different
`data-media-start`, alternating track indices. Audio can't be split this way — pre-cut one clean audio file.

## The BIT framework

His loop for turning a guided session into reusable taste:

- **B**uild — ship v1 by guiding the agent toward what good looks like.
- **I**ntegrate — fold everything you said in that session back into the skill.
- **T**une — repeat, so the skill converges on your standard.

He automates step I with a **`calibrate` skill**: at the end of a session, it self-analyses the
conversation and proposes bullet-point edits to the skill/memory. This is the generalisable idea —
it applies to any skill, not just video.

## Assessment

Unlike the second brain, **this is fully open and immediately usable.** Clone the kit, add the skill,
`npx hyperframes`. No Skool membership, no reverse-engineering.

The genuinely transferable ideas are the **storyboard-before-render** loop (cheap iteration on a plan
rather than an artefact), the **script-review.html approve-before-cut** gate, and the **BIT/calibrate**
loop. All three are domain-independent.

Caveat he's honest about: quality still takes many guided prompts. One-shot output is draft quality.
