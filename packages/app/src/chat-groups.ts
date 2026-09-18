/**
 * Chat groups in the app's lists: the project a chat belongs to ("Orbit"), set by a conductor's
 * fleet_rename, by you ("Move to group…") or by the host when a new chat's repo already has one.
 *
 * A list keeps its order: a group's chats come together as one block where its first chat was,
 * and an ungrouped chat stays exactly where it was. A collapsed group is remembered in this browser.
 */

export type Run<T> = { group: string | null; items: T[] }

/** the same tidying as the host's groupLabel (fleet-work.mjs): null when empty */
export const tidyGroup = (g: unknown): string | null => {
  const t = String(g ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return t || null
}

/** the list in runs: one per group (at its first chat) and one per stretch of ungrouped chats */
export function groupRuns<T>(items: readonly T[], groupOf: (x: T) => unknown): Run<T>[] {
  const runs: Run<T>[] = []
  const byGroup = new Map<string, Run<T>>()
  for (const x of items) {
    const g = tidyGroup(groupOf(x))
    if (g) {
      const had = byGroup.get(g)
      if (had) had.items.push(x)
      else {
        const run = { group: g, items: [x] }
        byGroup.set(g, run)
        runs.push(run)
      }
      continue
    }
    const last = runs[runs.length - 1]
    if (last && last.group === null) last.items.push(x)
    else runs.push({ group: null, items: [x] })
  }
  return runs
}

/** every group in use, A to Z */
export const knownGroups = (list: readonly { group?: string | null }[]): string[] =>
  [...new Set(list.map((x) => tidyGroup(x.group)).filter((g): g is string => !!g))].sort((a, b) =>
    a.localeCompare(b),
  )

const COLLAPSED_KEY = 'laika.chatGroupsCollapsed'

/** the groups you folded away, kept in this browser */
export function collapsedGroups(store: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  let set: Set<string>
  try {
    const got = JSON.parse(store.getItem(COLLAPSED_KEY) ?? '[]')
    set = new Set(Array.isArray(got) ? got.filter((g) => typeof g === 'string') : [])
  } catch {
    set = new Set()
  }
  return {
    has: (g: string) => set.has(g),
    toggle(g: string) {
      if (set.has(g)) set.delete(g)
      else set.add(g)
      try {
        store.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
      } catch {}
      return set.has(g)
    },
  }
}
