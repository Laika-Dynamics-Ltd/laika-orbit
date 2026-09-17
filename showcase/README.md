# Showcase

`index.html` is the product page; open it from this folder (it loads `media/`).

| Path | What it is |
| --- | --- |
| `showreel.config.mjs` | the film: scenes, captions, narration script, voice |
| `media/laika-1brain-film.mp4` | 42s 1080p narrated film |
| `media/laika-1brain-film-web.mp4`, `.jpg`, `.vtt` | what the page embeds: web encode, poster, captions |
| `media/<scene>.mp4` | silent feature loops |
| `demo/make-world.mjs`, `demo/run.mjs` | the fictional workspace everything is filmed on |

## Rebuild the film

Built with [laika-showreel](https://github.com/joesdevlab/laika-showreel) (installed as `showreel` by its
`install.sh`). `showreel studio` from this folder opens it in the browser studio.

```sh
cd showcase
showreel plan            # speak the script (local Kokoro voice, cached) and print the timing table
showreel build           # rebuild the demo world, film every scene, compose, render → media/
open media/laika-1brain-film.mp4
```

`showreel build` runs `demo/make-world.mjs` right before filming (session states are relative to the
time it was built, and a "running" session turns "blocked" after three minutes) and starts
`demo/run.mjs` on :5290 unless something already answers there. If something does, check it is the
demo server and not the real app.

Nothing filmed comes from a real machine. The demo server sets `HOME` to the fictional world,
`CONTROL_ASSUME_LIVE=1` (there are no real claude processes to find), `GMAIL_FEED=0` and an empty
`CALENDAR_ICS_URLS`, so the real calendar feed in `.env.local` is never loaded.
