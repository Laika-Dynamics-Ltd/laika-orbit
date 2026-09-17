import { describe, expect, it } from 'vitest'
import { tokenise } from '../src/tokenise.ts'

describe('tokenise', () => {
  it('drops stop words and lowercases', () => {
    expect(tokenise('Which TTS voice do we use?')).toEqual(['tts', 'voice'])
  })

  // The documented brain.js bug: stop words were stripped as SUBSTRINGS, so
  // removing "one" corrupted "Done" -> "D". Words containing a stop word must survive whole.
  it('REGRESSION: a stop word inside a real word must not be stripped', () => {
    expect(tokenise('everyone')).toEqual(['everyone']) // contains "one"
    expect(tokenise('milestone')).toEqual(['milestone']) // contains "one"
    expect(tokenise('android')).toEqual(['android']) // contains "an"
    expect(tokenise('software')).toEqual(['software']) // contains "of" + "are"
  })

  it('removes a stop word only when it is the whole word', () => {
    expect(tokenise('one')).toEqual([])
    expect(tokenise('one milestone')).toEqual(['milestone'])
  })

  it('is deterministic and de-duplicated', () => {
    expect(tokenise('render render RENDER')).toEqual(['render'])
    expect(tokenise('a b c')).toEqual([])
  })

  it('keeps hyphenated and underscored identifiers whole', () => {
    expect(tokenise('feedback_au_english and scale-fps')).toEqual([
      'feedback_au_english',
      'scale-fps',
    ])
  })
})
