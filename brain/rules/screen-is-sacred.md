# Rule — the user's screen and Mac come first

A person is working on this Mac. Verifying a change must never disturb them.

- Never pop windows, steal focus or add Dock icons to check something.
- Verify invisibly: headless or offscreen first. Start one hidden test copy on your own port and
  profile, reload it in place, never relaunch it per change, and close it when you finish. Never
  use the live app on :5200 or :5300.
- Use the lightest check that proves the fix. The full desktop shell only for what needs it
  (webviews, sign-ins, crashes, restart and restore), batched.
- Anything that must show on screen (a visible playtest, a demo) is announced first and runs only
  when the user says so or is away.
- CPU-only work goes to box1. GPU work runs one job at a time, never while the user is using the Mac.

Why: this came up five times in two days: over-testing, hidden panels still drawing, the Mac
running a game, two app copies and browsers at once, a playtest appearing on screen, and the dev
app relaunching for every browser change.
