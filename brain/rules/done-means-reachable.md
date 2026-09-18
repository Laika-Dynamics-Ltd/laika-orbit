# Rule — done means reachable and seen

A feature is not done because it merged and typechecks.

- UI work is done when a person can reach it (a rail button, a shortcut and a command palette
  entry) and it has been seen working in a screenshot of the real app.
- Before calling anything ready, check the wiring at the source: the new module is imported, the
  entry point exists, the panel is registered.
- Before calling a chat stalled, check its branch commits and their times. A chat's status line goes stale.

Why: on 18 Sep autopilot, runs and panels all merged and typechecked while panels.ts was imported
by nothing and runs had no way in; a cockpit merge crushed the conductor window and nobody looked.
