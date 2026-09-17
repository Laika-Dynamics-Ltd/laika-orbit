import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildIndex,
  compilePattern,
  DEFAULT_CONFIG,
  normaliseConfig,
  SourcedStore,
} from '../src/index.ts'

describe('compilePattern', () => {
  it('treats a plain pattern as a path prefix', () => {
    const m = compilePattern('docs/old/')
    expect(m('docs/old/a.md')).toBe(true)
    expect(m('docs/older.md')).toBe(false)
  })
  it('matches a slash-less glob against the file name at any depth', () => {
    const m = compilePattern('*.log')
    expect(m('a/b/run.log')).toBe(true)
    expect(m('a/log.md')).toBe(false)
  })
  it('lets ** span folders, including none', () => {
    const m = compilePattern('src/**/*.test.ts')
    expect(m('src/a.test.ts')).toBe(true)
    expect(m('src/x/y/a.test.ts')).toBe(true)
    expect(m('lib/a.test.ts')).toBe(false)
  })
})

describe('normaliseConfig', () => {
  it('reproduces the defaults from nothing', () => {
    expect(normaliseConfig({})).toEqual(normaliseConfig(DEFAULT_CONFIG))
  })
  it('rejects bad and duplicate source ids', () => {
    expect(() => normaliseConfig({ sources: [{ id: 'Bad Id', path: '.' }] })).toThrow(/id/)
    expect(() =>
      normaliseConfig({
        sources: [
          { id: 'a', path: '.' },
          { id: 'a', path: 'x' },
        ],
      }),
    ).toThrow(/twice/)
  })
  it('clamps numbers into range', () => {
    const c = normaliseConfig({ content: { maxTokensPerDoc: -5 }, weights: { topic: 1e9 } })
    expect(c.content.maxTokensPerDoc).toBe(10)
    expect(c.weights.topic).toBe(100)
  })
})

describe('SourcedStore', () => {
  let root = ''
  let extra = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), '1brain-root-'))
    extra = await mkdtemp(join(tmpdir(), '1brain-extra-'))
    await mkdir(join(root, 'notes/deep/deeper'), { recursive: true })
    await writeFile(join(root, 'notes/a.md'), 'alpha zebra')
    await writeFile(join(root, 'notes/skip.log'), 'noise')
    await writeFile(join(root, 'notes/deep/deeper/b.md'), 'bravo')
    await mkdir(join(root, 'cache/x'), { recursive: true })
    await writeFile(join(root, 'cache/x/c.md'), 'cached')
    await writeFile(join(extra, 'c.md'), 'charlie quokka')
    await writeFile(join(extra, 'd.txt'), 'delta')
    await writeFile(join(extra, 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    await writeFile(join(root, 'notes/deep/deeper/shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(extra, { recursive: true, force: true })
  })

  it('prunes an excluded folder without walking it', async () => {
    const cfg = normaliseConfig({
      sources: [{ id: 'main', path: '.' }],
      exclude: ['cache/', '**/deeper/**'],
    })
    const store = new SourcedStore(root, cfg)
    const paths: string[] = []
    for await (const d of store.listDocs()) paths.push(d.path)
    expect(paths.sort()).toEqual(['notes/a.md'])
    const scan = store.parts[0]?.store.lastScan
    expect(scan?.examples.excluded).toEqual(
      expect.arrayContaining(['cache/', 'notes/deep/deeper/']),
    )
    expect(scan?.seen).toBe(2) // a.md and skip.log; nothing under the pruned folders
  })

  it('indexes an image only when a source includes it by name, and never reads it', async () => {
    const cfg = normaliseConfig({
      sources: [
        { id: 'main', path: '.' },
        { id: 'ext', path: extra, include: ['*.md', '*.png'] },
      ],
      exclude: ['cache/'],
    })
    const store = new SourcedStore(root, cfg)
    const paths: string[] = []
    for await (const d of store.listDocs()) paths.push(d.path)
    // main has no include list, so its png stays binary; ext names *.png, so it is kept
    expect(paths.sort()).toEqual([
      '@ext/c.md',
      '@ext/hero.png',
      'notes/a.md',
      'notes/deep/deeper/b.md',
    ])
    expect(store.parts[0]?.store.lastScan.skipped.binary).toBe(1)
    expect(await store.readDoc('@ext/hero.png')).toBe('')
    const idx = await buildIndex(store, {
      indexContent: true,
      contentFor: (p) => store.contentFor(p),
    })
    expect(idx.contentTokens.get('@ext/hero.png') ?? []).toEqual([])
    const hero = idx.byPath.get('@ext/hero.png') as number
    expect(idx.postings.get('hero')?.includes(hero)).toBe(true) // findable by name
  })

  it('prefixes extra sources, applies include/depth, and routes reads back', async () => {
    const cfg = normaliseConfig({
      sources: [
        { id: 'main', path: '.', maxDepth: 2 },
        { id: 'ext', path: extra, include: ['*.md'], content: false },
      ],
      exclude: [],
    })
    const store = new SourcedStore(root, cfg)
    const paths: string[] = []
    for await (const d of store.listDocs()) paths.push(d.path)
    expect(paths.sort()).toEqual(['@ext/c.md', 'cache/x/c.md', 'notes/a.md'])
    expect(store.parts[0]?.store.lastScan.skipped.tooDeep).toBe(1)
    expect(store.parts[0]?.store.lastScan.skipped.noise).toBe(1)
    expect(store.parts[1]?.store.lastScan.skipped.notIncluded).toBe(1)
    expect(await store.readDoc('@ext/c.md')).toBe('charlie quokka')

    const idx = await buildIndex(store, {
      indexContent: true,
      contentFor: (p) => store.contentFor(p),
    })
    expect(idx.contentDocs).toBe(2) // a.md and cache/x/c.md; ext has content off
    expect(idx.postings.has('zebra')).toBe(true)
    expect(idx.postings.has('quokka')).toBe(false)
  })
})

describe('ROUTER_PATH', () => {
  it('matches routers in the primary source only', async () => {
    const { ROUTER_PATH } = await import('../src/index.ts')
    expect(ROUTER_PATH.test('brain/CLAUDE.md')).toBe(true)
    expect(ROUTER_PATH.test('brain/routers/CONTENT.md')).toBe(true)
    expect(ROUTER_PATH.test('CLAUDE.md')).toBe(true)
    expect(ROUTER_PATH.test('@dev/some-repo/CLAUDE.md')).toBe(false)
    expect(ROUTER_PATH.test('@claude/projects/x/memory/routers/a.md')).toBe(false)
  })
})
