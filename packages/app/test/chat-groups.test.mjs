import { describe, expect, it } from 'vitest'
import { collapsedGroups, groupRuns, knownGroups, tidyGroup } from '../src/chat-groups.ts'

describe('chat groups in the lists', () => {
  const c = (id, group = null) => ({ id, group })
  const shape = (runs) => runs.map((r) => [r.group, r.items.map((x) => x.id).join('')])

  it('brings a group together where its first chat was, and leaves ungrouped chats in place', () => {
    const list = [c('a'), c('b', 'Orbit'), c('c'), c('d', 'Atlas'), c('e', ' Orbit'), c('f'), c('g')]
    expect(shape(groupRuns(list, (x) => x.group))).toEqual([
      [null, 'a'],
      ['Orbit', 'be'],
      [null, 'c'],
      ['Atlas', 'd'],
      [null, 'fg'],
    ])
    expect(shape(groupRuns([c('a'), c('b', '  ')], (x) => x.group))).toEqual([[null, 'ab']])
    expect(groupRuns([], (x) => x.group)).toEqual([])
  })

  it('lists the groups in use, tidied, A to Z', () => {
    expect(knownGroups([c('a', 'orbit'), c('b', 'Atlas'), c('c', ' Atlas '), c('d')])).toEqual(['Atlas', 'orbit'])
    expect(tidyGroup('  a   b ')).toBe('a b')
    expect(tidyGroup('')).toBeNull()
    expect(tidyGroup('x'.repeat(60))).toHaveLength(40)
  })

  it('remembers folded groups, and survives a bad value', () => {
    const data = new Map()
    const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }
    const a = collapsedGroups(store)
    expect(a.toggle('Orbit')).toBe(true)
    expect(collapsedGroups(store).has('Orbit')).toBe(true)
    expect(a.toggle('Orbit')).toBe(false)
    expect(collapsedGroups(store).has('Orbit')).toBe(false)
    data.set('laika.chatGroupsCollapsed', '{nope')
    expect(collapsedGroups(store).has('Orbit')).toBe(false)
  })
})
