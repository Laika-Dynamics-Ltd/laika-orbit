# The work queue — the contract

Published 2026-09-18 from `feature/queue`. **Frozen once published**: the UI chats build against
this. Any change to a shape, route, event or tool name below is announced before it lands.

The queue holds work that has been decided but not yet done. Today that lives only in the
conductor's head, so closing a chat mid-flight loses the intent. The queue is server-side state:
it survives a host restart, and an item outlives the chat it was assigned to.

This document is the whole contract: the item shape, the HTTP routes, the event names, and the
conductor tools. There is no UI in this branch.

---

## 1. The item

Every item the API returns has exactly these fields. `retries`, `needsUser`, `ready` and
`waitingOn` are engine-owned — you read them, you never send them.

```jsonc
{
  "id": "q_l3kf9a2p",            // string, assigned by the engine
  "repo": "laika-orbit",        // string, the repo name the work belongs to
  "chatId": null,                // string | null — null means it sits in the unassigned pile
  "title": "Wire the rail to the queue API",   // one line, <= 120 chars
  "brief": "Build the rail…",    // the full text sent to the chat, <= 8000 chars
  "state": "queued",             // queued | running | blocked | done | cancelled
  "blockedBy": ["q_l3kf7x10"],   // item ids; this item never starts until all are done
  "order": 0,                    // position within its chat's list, or the unassigned pile
  "estimate": 45,                // minutes, or null
  "machine": "any",              // mac | box1 | any
  "createdBy": "conductor",      // user | conductor | chat
  "done": {                      // the definition of done; all three true = genuinely finished
    "committed": false,
    "reachable": false,
    "verified": false
  },
  "artefacts": ["packages/app/queue.mjs"],  // repo-relative or absolute paths
  "createdAt": 1758193200000,    // ms epoch
  "startedAt": null,             // ms epoch, set when it is sent to a chat
  "finishedAt": null,            // ms epoch, set on done or cancelled
  "lastError": null,             // string | null — why the last attempt failed

  // engine-owned, read-only
  "retries": 0,                  // automatic retries used, 0..2
  "needsUser": false,            // true once retries are spent: no more automatic sends
  "ready": false,                // derived: dispatchable right now (see §2)
  "waitingOn": ["q_l3kf7x10"]    // derived: the blockedBy that are not done yet
}
```

### States

| state | means |
|---|---|
| `queued` | waiting. The normal resting state, including after a failure. |
| `running` | its brief has been sent to a chat and that chat has not finished it. |
| `blocked` | held by a person or the engine for a reason that is not a dependency. Never entered automatically by dependency: that is `queued` with a non-empty `waitingOn`. |
| `done` | finished. Only `done` items satisfy another item's `blockedBy`. |
| `cancelled` | dropped. Kept in the list (so history reads straight) but never dispatched and never satisfies a dependency. |

`done` the **state** and `done` the **object** are different things. The state is where the item
sits; the object is the three-way definition of done. Setting the state to `done` does not set the
flags, and setting all three flags does not set the state. Both are yours to set.

### `ready` — the one rule the UI should trust

`ready` is true when **all** of:

- `state === 'queued'`
- every id in `blockedBy` names an item whose state is `done` (`waitingOn` is empty)
- `needsUser === false` (its two automatic retries are not spent)
- it has a `chatId`, **or** it is in the unassigned pile and a chat could take it

A ready item with a `chatId` is sent automatically the moment that chat goes idle — but only on
autopilot and inside the away budget (§2). Off autopilot it stays `ready: true, state: 'queued'`
and waits for a person. That is the "mark it ready and leave it" case: the UI should show ready
items as the next thing that would go out.

### Ordering

`order` is a number within one list — a chat's list, or the unassigned pile. Ties break by
`createdAt`. Moving an item between chats renumbers it to the end of its new list unless you say
otherwise. The engine never renumbers behind your back except on that move.

### Dependencies

- `blockedBy` holds item ids. An item with unsatisfied dependencies is never sent, whatever
  autopilot says.
- Cycles are refused at write time, on both the API and the tools, with the cycle spelled out.
  A refused write changes nothing.
- An id in `blockedBy` that names no item is refused at write time.
- Depending on a `cancelled` item leaves the dependent stuck. The API says so in `waitingOn`;
  it is up to a person or the conductor to clear it.

---

## 2. Dispatch, retries and chat lifecycle

**Automatic send.** When a chat goes idle, the engine looks for its lowest-`order` ready item. If
one exists it sets `startedAt`, moves it to `running`, and sends `brief` to the chat exactly as a
conductor's `fleet_send` would (same prefix, same timeline entry). This happens only when:

- some conductor has autopilot on, and
- the away budget allows a send (the same gate `fleet_send` uses).

With autopilot off, nothing is sent. The item stays `queued` with `ready: true`.

**Finishing.** The engine does not decide an item is done. A chat, a person or the conductor sets
`state: 'done'` (and the `done` flags). An item left `running` by a chat that went idle without
being marked is reported as `running` with a stale `startedAt` — the UI should show that as
"sent, not yet confirmed done".

**Failure.** If the chat errors or hits a usage limit while an item is `running`, the item goes
back to `queued`, `lastError` is set, `startedAt` is cleared and `retries` goes up by one. At
`retries === 2` the engine sets `needsUser: true` and stops sending it. Clearing `lastError`
through an update resets `retries` to 0 and `needsUser` to false — that is how a person says
"try again".

**A chat closing or parking.** Every item assigned to that chat that is not `done` or `cancelled`
goes back to the unassigned pile (`chatId: null`), keeping its state, its `blockedBy`, its
`lastError` and its retry count, and is appended to the end of the pile. Nothing is ever deleted
because a chat went away. A `queue.reassigned` event fires for each one.

**One at a time per chat** (added after publishing; no shape changed). A chat that still holds a
`running` item gets nothing new, even when it is idle: that item has to be marked `done` (or fail)
first, so work never piles up on a chat behind the conductor's back. Marking it done sends the next
one on the next idle, and frees any items in other chats that were waiting on it.

**Retry backoff** (added after publishing). A failed item is not sent again for 2 minutes times its
retries spent, so a usage limit cannot burn both retries in a few seconds.

**Restart.** The queue is a file on disk, written with an atomic rename, at
`~/.laika/queue-<port>.json` (override with `LAIKA_QUEUE`). It is read back on boot. Items that
were `running` when the host died come back as `queued` with `lastError` saying the host
restarted — they do not count against the retry budget.

---

## 3. HTTP routes

All under `/api/control/agent/queue`, proxied to the agent host like every other `agent/*` route.
**Every non-GET needs the `x-control: 1` header** — the proxy refuses writes without it.
Responses are JSON; errors are `{ "error": "<one line>" }` with a 400, 404 or 409.

| method | route | body | answers |
|---|---|---|---|
| `GET` | `/api/control/agent/queue` | — | `{ v, now, items, unassigned, byChat, counts }` |
| `POST` | `/api/control/agent/queue` | new item (below) | the created item |
| `GET` | `/api/control/agent/queue/<id>` | — | one item |
| `PATCH` | `/api/control/agent/queue/<id>` | partial item | the updated item |
| `POST` | `/api/control/agent/queue/<id>/assign` | `{ chat: "<chatId>" \| null }` | the updated item |
| `POST` | `/api/control/agent/queue/<id>/cancel` | `{ reason? }` | the updated item |
| `DELETE` | `/api/control/agent/queue/<id>` | — | `{ ok: true }` — purges the row outright; the tools never do this |
| `POST` | `/api/control/agent/queue/reorder` | `{ chat: "<chatId>" \| null, ids: [...] }` | `{ ok, items }` — for drag-and-drop |
| `GET` | `/api/control/agent/queue/events?since=<seq>` | — | SSE (§4) |

**`GET /api/control/agent/queue` answers:**

```jsonc
{
  "v": 1,
  "now": 1758193200000,
  "items": [ /* every item, order within list, unassigned pile last */ ],
  "unassigned": ["q_l3kf9a2p"],                 // ids, in order
  "byChat": { "<chatId>": ["q_l3kf7x10"] },     // ids, in order, per chat
  "counts": { "queued": 4, "running": 1, "blocked": 0, "done": 12, "cancelled": 1, "ready": 2, "needsUser": 0 }
}
```

`?chat=<id>` narrows to one chat, `?chat=none` to the unassigned pile, `?state=queued,running`
filters by state, `?repo=<name>` by repo. `?include=done` is needed to see finished and cancelled
items; by default they are left out of `items` but still counted in `counts`.

**`POST` body** — `title` and `brief` are required, everything else optional and defaulted:
`repo` (defaults to the assigned chat's repo), `chatId` (null), `blockedBy` ([]), `order` (end of
its list), `estimate` (null), `machine` (`"any"`), `createdBy` (`"user"`), `done`
(all false), `artefacts` ([]).

**`PATCH` body** — any of `title`, `brief`, `state`, `blockedBy`, `order`, `estimate`, `machine`,
`artefacts`, `lastError`, and `done` (partial: `{ "done": { "verified": true } }` leaves the other
two alone). `chatId` is not patchable — use `/assign`, so the reassignment event fires.

---

## 4. Events

One SSE stream: `GET /api/control/agent/queue/events?since=<seq>`. Frames are
`id: <seq>\ndata: <json>\n\n`, with a `: ping` every 15s, exactly like the chat event streams.
The last 500 events are kept in memory, so `since` replays what a reconnecting page missed; on a
host restart the sequence starts again and the page should refetch `GET .../queue`.

Every frame: `{ seq, at, t, item, ... }` where `t` is the event name and `item` is the full item
in its state **after** the change.

| `t` | when | extra fields |
|---|---|---|
| `queue.added` | an item is created | — |
| `queue.started` | an item's brief was sent to a chat | `chatId`, `auto` (true when the engine sent it, false when a person or tool did) |
| `queue.finished` | an item reached `done` | `doneFlags` |
| `queue.blocked` | an item entered `blocked`, or a ready item was held back by a dependency | `why` |
| `queue.failed` | an attempt failed | `error`, `retries`, `needsUser` |
| `queue.reassigned` | `chatId` changed, including a chat closing or parking | `from`, `to`, `why` |
| `queue.ready` | a `queued` item became dispatchable but was not sent (autopilot off, or the budget is spent) | `why` |
| `queue.updated` | any other field changed (title, brief, order, estimate, blockedBy, done flags short of finishing) | `fields` — the names that changed |
| `queue.cancelled` | an item was cancelled | `reason` |

The six names you were promised are `added`, `started`, `finished`, `blocked`, `failed`,
`reassigned`; `ready`, `updated` and `cancelled` are there so a live list never has to poll.

Items assigned to a chat also get a compact `{ t: 'queue', event, id, title, state }` note on that
chat's own session stream, so the chat transcript shows what the queue did to it. That mirror is a
convenience — the queue stream above is the source of truth.

---

## 5. Conductor tools

Same style, same refusals, as the other `fleet_*` tools: a refusal is one line saying what to do
instead, and it changes nothing.

**`fleet_queue_add`** — put work on the queue.

| arg | type | |
|---|---|---|
| `title` | string, required | one line |
| `brief` | string, required | the full text that will be sent |
| `chat` | string | the chat to assign it to; leave it out for the unassigned pile |
| `repo` | string | defaults to the chat's repo |
| `blockedBy` | string[] | item ids this waits on |
| `after` | string | sugar: one item id, the same as `blockedBy: [id]` |
| `estimate` | number | minutes |
| `machine` | `mac` \| `box1` \| `any` | default `any` |
| `order` | number | default: end of its list |

Refuses: an unknown chat, an unknown `blockedBy` id, a cycle, a title or brief over length.

**`fleet_queue_list`** — the queue as the conductor should read it: what is running, what is ready
to go out, what is waiting on what, and what is stuck waiting for the user.

| arg | type | |
|---|---|---|
| `chat` | string | one chat, or `"none"` for the unassigned pile |
| `state` | string[] | filter |
| `repo` | string | filter |
| `includeDone` | boolean | default false |

**`fleet_queue_update`** — change an item.

| arg | type | |
|---|---|---|
| `id` | string, required | |
| `state` | `queued`\|`running`\|`blocked`\|`done`\|`cancelled` | |
| `order` | number | |
| `blockedBy` | string[] | replaces the list |
| `done` | `{ committed?, reachable?, verified? }` | partial |
| `title`, `brief`, `estimate`, `machine` | | |
| `artefacts` | string[] | replaces the list |
| `clearError` | boolean | clears `lastError` and resets the retry budget |

Refuses: an unknown id, a cycle, `state: 'running'` on an item whose dependencies are not done,
`state: 'done'` on a cancelled item.

**`fleet_queue_assign`** — move an item to a chat, or back to the unassigned pile.

| arg | type | |
|---|---|---|
| `id` | string, required | |
| `chat` | string \| null, required | the chat, or null to unassign |
| `why` | string | one line, shown in the autopilot timeline |

Refuses: an unknown chat, an unknown id, a `done` or `cancelled` item, and — off autopilot —
nothing: assigning is not sending, so it is allowed either way.

**`fleet_queue_cancel`** — drop an item.

| arg | type | |
|---|---|---|
| `id` | string, required | |
| `reason` | string | one line |

Refuses: an unknown id, an item already `done`. Cancelling an item other items depend on succeeds
but says which items are now stuck.

---

## 6. The UI that ships with it

The **Queue** panel (its rail button in the fleet group, ⌥⌘Q, "Queue" in the palette, or the
Queue button in the header toolbar, which shows the open count) holds each chat's list, the
unassigned pile and what finished, with add, mark done, the done flags, retry, move and cancel.
It uses only the routes and the stream above. The view is `mountQueue(host)` in
`src/queue-view.ts` and draws no chrome: main.ts registers it as a panel the way `runs-panel.ts`
hosts Runs, and `/queue.html` hosts the same mount on its own page. Not a bare `q`: that is the
map's orbit key.
