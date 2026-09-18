# Rule — commit early, ship in slices

- Commit a skeleton within 10 minutes, then after each working piece, and before going idle.
  Uncommitted work is lost when a chat is closed.
- Deliver the smallest useful fix first, as its own commit with its own ETA, and say it's ready so
  it can be merged. Don't finish a whole list before handing anything over.
- For parallel work on one surface, the shared contract (exact API, who lands it first) goes in
  every brief before anyone starts. One owner per surface.

Why: on 18 Sep three chats were closed before their first commit and lost everything; three
others built their own temporary chrome against an API that hadn't landed yet.
