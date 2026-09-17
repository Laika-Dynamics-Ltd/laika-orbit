import { describe, expect, it } from 'vitest'
import { claudeProjectName, docKind, projectOf, smartGroups } from '../src/index.ts'

describe('docKind', () => {
  it.each([
    ['@claude/projects/-Users-j-dev-x/memory/gauntlet-kit.md', 'memory'],
    ['@claude/skills/gauntlet-loop/SKILL.md', 'skill'],
    ['@dev/app/.claude/agents/reviewer.md', 'agent'],
    ['@dev/app/CLAUDE.md', 'agent'],
    ['@dev/app/README.md', 'readme'],
    ['@dev/app/CHANGELOG.md', 'changelog'],
    ['@dev/app/docs/adr/0003-queue.md', 'decision'],
    ['@dev/app/docs/2026-04-08-firestore-rules-fixed.md', 'docs'],
    ['PLAN.md', 'plan'],
    ['@documents/Harbour Cycles Ltd/HARBOUR_Director_Consent.pdf', 'legal'],
    ['@documents/Studio/Client Engagement Letter.pdf', 'legal'],
    ['@documents/Acme/Launch/Acme 2026 - Branding 5-1.pdf', 'brand'],
    ['@downloads/EStatement.pdf', 'finance'],
    ['@dev/app/docs/problem-statement.md', 'docs'],
    ['@dev/app/src/directory-listing.md', 'other'],
    ['@dev/acme-financial-model-sveltekit/UI-IMPROVEMENTS.md', 'other'],
    ['@dev/demo/acme-gateway/finance/model-notes.md', 'finance'],
    ['@dev/demo/decisions-w4t4.md', 'decision'],
    ['@dev/x/QUICK_START.md', 'guide'],
    ['@dev/x/ERROR-CONTEXT.md', 'agent'],
    ['research/notes/transcript-agentic-os-arms.txt', 'research'],
    ['packages/app/src/main.ts', 'code'],
    ['biome.json', 'data'],
    ['@documents/Acme/Acme - Home Hero.jpg', 'image'],
    ['@documents/Corner Cafe/cafe-logo.png', 'image'],
  ])('%s → %s', (p, k) => {
    expect(docKind(p)).toBe(k)
  })
})

describe('projectOf', () => {
  const roots = new Set(['8-fitness-beta', 'Studio/moonbase', 'mono'])
  const isRoot = (d: string) => roots.has(d)
  it('uses the outermost project root, so monorepos stay whole and org folders nest', () => {
    expect(projectOf('8-fitness-beta/docs/a.md', 'dev', isRoot)).toBe('8-fitness-beta')
    expect(projectOf('Studio/moonbase/lanes/x.md', 'dev', isRoot)).toBe('Studio/moonbase')
    expect(
      projectOf(
        'mono/packages/web/README.md',
        'dev',
        (d) => d === 'mono' || d === 'mono/packages/web',
      ),
    ).toBe('mono')
  })
  it('falls back to the first folder, and names top-level files', () => {
    expect(projectOf('Acme/Launch/deck.pdf', 'documents', () => false)).toBe('Acme')
    expect(projectOf('notes.md', 'documents', () => false)).toBe('(top)')
  })
  it('reads Claude project folders', () => {
    expect(
      projectOf('projects/-Users-sam-dev-Acme-NZ-LTD/memory/a.md', 'claude', () => false),
    ).toBe('Acme-NZ-LTD')
    expect(projectOf('plans/x.md', 'claude', () => false)).toBe('plans')
    expect(claudeProjectName('-Users-sam-dev-Studio-Tools-orbit')).toBe('Studio-Tools-orbit')
  })
})

describe('smartGroups', () => {
  it('keeps the primary taxonomy, splits big projects, and merges the tail', () => {
    const items = [
      { source: 'workspace', project: 'x', folder: 'packages', primary: true },
      ...Array.from({ length: 3 }, () => ({
        source: 'dev',
        project: 'Org/big',
        folder: '@dev',
        primary: false,
      })),
      { source: 'dev', project: 'tiny', folder: '@dev', primary: false },
    ]
    expect(smartGroups(items, { minSize: 2 })).toEqual([
      'packages',
      'dev/Org/big',
      'dev/Org/big',
      'dev/Org/big',
      'dev · other',
    ])
  })
})
