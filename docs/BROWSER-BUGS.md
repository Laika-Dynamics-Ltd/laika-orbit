# Browser bug hunt (fix/browser)

The Orbit browser: the Electron shell (`packages/shell`) and the in-page dock
(`packages/app/src/browser.ts`). Found by using it on an isolated port (:5296) and profile
(`/tmp/wbx/userData`), ranked by how much each one gets in the way. Each fix is its own commit.

Principle: isolated underneath, connected on top. A crashed or hung page breaks only its own
tab (a small reload in that tab), never the panel or the app. Hidden tabs cost nothing beyond
what the page itself needs (activity.ts).

How each was seen: **shell** = in the hidden test copy of the shell, **headless** = the app page
in headless Chromium with a stand-in shell, **code** = read in the code, not reproduced.

## Asked for

- [x] The new-tab "+" sits right after the last tab and moves with it; on overflow it stays
  visible at the end of the row. (headless) — 1b5a0c3

## Found, ranked

1. [x] **The tab strip freezes once any tab goes out of view.** Open a tab, open a second (the
   first goes out of view), open a third: the strip still shows the old set, closed tabs stay,
   new ones never appear. The state push carried a live timer and failed ("Failed to serialize
   arguments" in the shell log). (shell) — bb7fc54
2. [x] **Typing jumps into the web page.** Browser open, type in a chat. Anything that
   overlapped the browser closing (a tooltip, a menu, a toast, the palette) makes the shell
   hand keyboard focus to the web tab, so the next keys go into the page. (code: `shell:covered`)
3. [x] **Browser keys fire while you are somewhere else.** Browser open, cursor in a chat:
   ⌘W closes the web tab, ⌘F opens the page's find bar, ⌘R reloads the page, ⌘[ ⌘] step the
   page back and forward, ⌘L/⌘D/⌘1–9/⌃Tab act on the browser. The menu only checks that the
   dock is open. (code: `buildMenu`)
4. [ ] **A panel squeezes the web page to 220 px.** 1600 px window, chats docked, browser open,
   open Queue (⌥⌘Q): the page goes 712 → 220 px wide. The window system treats the browser as
   the map, which gives up width first. Needs panels.ts (below). (headless)
5. [x] **Tab clicks are dropped while a page loads or a download runs.** The strip is rebuilt
   on every state push; 5 of 10 clicks lost at 30 pushes/s, 10 of 10 when quiet. The strip also
   scrolls back to the active tab on every push. (headless)
6. [x] **Orbit's own keys are dead while a web page has focus**: ⌥⌘ arrows, ⌥⌘W/V/↩/=/-//,
   the panel chords (⌥⌘A/B/L/P/Q, ⇧⌥⌘C/D/P/Y), ⌃1–9 workspaces, the chats' ⌥⌘F/S/E. Only ⌘K is
   passed on. And ⌥⌘L is taken twice: the shell's Downloads and the Cockpit panel. (code)
7. [x] **The page goes blank whenever anything overlaps it**: a menu, tooltip, toast, the
   palette, the YouTube player. The native view is taken off until it closes, and the dock
   shows an empty area. (shell)
8. [x] **A crashed page shows nothing.** The shell notes "The page crashed" but the dead view
   stays over the dock, the strip gives no sign, and there is no reload in the tab. (shell)
9. [x] **A hung page shows nothing.** The app stays responsive (checked), but the tab gives no
   sign and offers no reload. (shell)
10. [x] **A link from Orbit with no tabs open adds a blank tab and shows that instead.** (shell)
11. [x] **Sign-ins kept in session cookies are lost at every restart.** A persistent cookie
    survives a quit, a session cookie does not; Chrome keeps them when it restores tabs. (shell)
12. [~] ~~**Tabs out of view keep running**~~ **Withdrawn: a measuring artefact.** Playwright attached to the tab makes it count as visible; with raw CDP the same tab is hidden with 0 frames. Tabs out of view are paused. at full speed** until the 10-minute sleep: the page
    reports itself visible, 60 animation frames a second, timers unthrottled. (shell)
13. [x] **The dock's overlap check never idles**: every 300 ms and on any attribute change in
    the app while the browser is open, even with Orbit away or hidden (102 probes in 3 s at
    "away"). (shell)
14. [x] **The browser's saved state can be wiped.** Saves are not atomic and can overlap; a torn
    file makes the next launch start fresh with one "Personal" profile, so every profile,
    sign-in, tab and bookmark is gone. (code, not reproduced)
15. [x] **A page asking for camera, microphone or location blocks all of Orbit** with a sheet
    over the whole window until answered. (code)
16. [x] **A page with an unsaved-changes guard silently ignores a new address.** (code)
17. [x] ~~The test copy exits silently~~ **Not a browser bug: the test copy was on screen.**
    Moving a window to x -20000 does not hide it on macOS (it was put back at x 0), so each
    "hidden" launch drew Orbit over the screen and closing it quit the copy. Hidden mode is now
    transparent, click-through and unfocusable. — 92ef29e
18. [x] **The toolbar spills over the panel beside a squeezed browser.** At 220 px, five controls
    drew over the panel next to it. (headless) — 7040308

## Needed from panels.ts (owned by the window-system chat)

- **A larger stage minimum while the browser is open** (bug 4). `room()` keeps the stage at
  `MIN_STAGE = 220`, fine for the map, useless for a web page. Ask: read the minimum from a CSS
  custom property, e.g. `parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stage-min')) || MIN_STAGE`,
  and the browser sets `--stage-min: 640px` on `<html>` while it is open. Nothing else changes.
- **The list of keys Orbit owns** (bug 6), so the browser passes exactly those on from a web page
  instead of a copy that drifts: an exported `ownedKeys(): { code: string; alt: boolean; meta:
  boolean; ctrl: boolean; shift: boolean }[]` covering the window keys, the panel chords and ⌃1–9.
  Until then the browser keeps its own copy of that list.
- Noticed, not ours: ⌥⌘A is both the Autopilot chord (panels, capture phase) and the chats'
  "I'm away" (sessions.ts); the chord wins everywhere outside the chats pane.
