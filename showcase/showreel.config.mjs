/**
 * The Laika Orbit showcase film. Build it with `showreel build` from this folder, or open it with
 * `showreel studio` (github.com/joesdevlab/laika-showreel). Everything is filmed on the fictional world in demo/.
 */
export default {
  name: 'laika-orbit-film',
  title: 'Laika Orbit — showcase film',

  app: {
    setup: 'node demo/make-world.mjs', // session states are relative to build time, so rebuild right before filming
    start: 'node demo/run.mjs',
    url: 'http://127.0.0.1:5290/',
    ready: '.widget[data-id="agents"] .w-item',
  },

  voice: {
    engine: 'kokoro',
    voice: 'am_echo', // young; Laika is LAY-kah (Joe's pick from a numbered audition)
    speed: 1.1,
    pronounce: { Laika: '/lˈeɪkɐ/', '⌘K': 'Command K' },
  },

  out: { build: '.showreel', media: 'media' },

  intro: {
    brand: 'LAIKA·ORBIT',
    headline: 'One window for *every agent*.',
    sub: 'A local mission control for developers running many AI coding sessions across many projects.',
    narration: 'Laika Orbit. One window for every coding agent you run.',
  },

  scenes: [
    {
      id: 'control',
      trim: 0.3,
      caption: { title: 'Know which agent is waiting on you', sub: 'Every session, every repo: your turn, blocked, working.' },
      narration:
        'Run a dozen agents and the hard part is knowing which one is waiting on you. Press C, and every session in every repo is sorted: your turn, blocked, or still working. Resume the one that needs you in a click.',
      async record(h) {
        await h.wait(1500)
        const box = await h.page.locator('.widget[data-id="agents"]').boundingBox()
        if (box) await h.glide([box.x + box.width * 0.4, box.y + 60], { steps: 45 })
        await h.wait(1800)
        await h.press('c')
        await h.wait(2600)
        await h.point('#ctl-drawer .c-card.needs-you [data-act="resume"]', { click: true })
        await h.wait(1400)
        await h.glide([h.W / 2, h.H / 2], { steps: 20 })
        await h.scroll(528, 24)
        await h.wait(2000)
      },
    },
    {
      id: 'map',
      trim: 1.5,
      caption: { title: 'Your whole workspace, one map', sub: 'Repos, agent memory, plans, skills and docs, indexed on your machine.' },
      narration: 'Behind it, your whole workspace as one map. Repos, agent memory, plans, skills and docs, indexed on your own machine.',
      async record(h) {
        await h.wait(2500)
        const a = [h.W / 2 + 60, h.H / 2 + 120]
        const b = [h.W / 2 + 60, h.H / 2 + 20]
        await h.page.mouse.move(...a)
        await h.page.mouse.down()
        await h.glide(b, { from: a, steps: 90 })
        await h.wait(900)
        await h.glide(a, { from: b, steps: 90 })
        await h.page.mouse.up()
        await h.wait(2500)
      },
    },
    {
      id: 'spotlight',
      trim: 0.8,
      caption: { title: 'Find it, preview it in place', sub: '⌘K, type a word, Space for an instant preview. No editor window needed.' },
      narration: '⌘K finds a file by any word inside it. Press space, and it opens right there. No editor window needed.',
      async record(h) {
        await h.wait(1200)
        await h.press('Meta+k')
        await h.wait(600)
        await h.type('passkey', 110)
        await h.wait(1800)
        await h.press('Enter')
        await h.wait(2200)
        await h.press(' ')
        await h.wait(3200)
        await h.press('Escape')
        await h.wait(1200)
      },
    },
    {
      id: 'recall',
      trim: 0.9,
      caption: { title: 'Answers from your own notes', sub: 'Milliseconds, zero model calls, nothing leaves the machine.' },
      narration: 'Ask it anything, and the answer comes from your own notes. In milliseconds, with zero model calls, and nothing leaves the machine.',
      async record(h) {
        await h.wait(1200)
        await h.page.click('#q')
        await h.type('how do we rotate staging credentials', 55)
        await h.wait(400)
        await h.press('Enter')
        await h.wait(5500)
      },
    },
  ],

  outro: {
    brand: 'LAIKA·ORBIT',
    headline: 'Close the heavy windows.',
    pills: ['Local', 'Private', 'Built for agent-heavy dev work'],
    narration: 'Laika Orbit. Close the heavy windows.',
  },
}
