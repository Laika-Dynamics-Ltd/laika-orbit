import { describe, expect, it, vi } from 'vitest'

// activity.ts watches the page at import time; parseYouTube needs none of it
vi.mock('../src/activity.ts', () => ({ every: () => () => {} }))
const { parseYouTube } = await import('../src/youtube.ts')

/**
 * What the floating player accepts. The link is whatever the user has on the clipboard:
 * a share link, a music link, a playlist, a short, a bare id. Anything it cannot read is
 * null, which the player treats as a search rather than playing the wrong thing.
 */
describe('parseYouTube', () => {
  it('reads a watch link', () => {
    expect(parseYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      video: 'dQw4w9WgXcQ',
    })
  })

  it('reads a share link, with its start time', () => {
    expect(parseYouTube('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toEqual({
      video: 'dQw4w9WgXcQ',
      start: 90,
    })
    expect(parseYouTube('https://youtu.be/dQw4w9WgXcQ?t=42')).toEqual({
      video: 'dQw4w9WgXcQ',
      start: 42,
    })
  })

  it('reads a YouTube Music link and keeps its playlist', () => {
    expect(
      parseYouTube('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=OLAK5uy_abcdefghijk'),
    ).toEqual({ video: 'dQw4w9WgXcQ', list: 'OLAK5uy_abcdefghijk' })
  })

  it('reads a playlist on its own', () => {
    expect(parseYouTube('https://www.youtube.com/playlist?list=PLabcdefghijkl')).toEqual({
      list: 'PLabcdefghijkl',
    })
  })

  it('reads shorts, live and embed links', () => {
    for (const path of ['shorts', 'live', 'embed']) {
      expect(parseYouTube(`https://www.youtube.com/${path}/dQw4w9WgXcQ`)).toEqual({
        video: 'dQw4w9WgXcQ',
      })
    }
  })

  it('reads bare ids, and a link without its scheme', () => {
    expect(parseYouTube('dQw4w9WgXcQ')).toEqual({ video: 'dQw4w9WgXcQ' })
    expect(parseYouTube('PLabcdefghijkl')).toEqual({ list: 'PLabcdefghijkl' })
    expect(parseYouTube('youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ video: 'dQw4w9WgXcQ' })
  })

  it('is null for anything else, which the player searches instead', () => {
    expect(parseYouTube('lofi beats to work to')).toBeNull()
    expect(parseYouTube('https://vimeo.com/76979871')).toBeNull()
    // a look-alike host is not YouTube
    expect(parseYouTube('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(parseYouTube('https://www.youtube.com/')).toBeNull()
    expect(parseYouTube('   ')).toBeNull()
  })
})
