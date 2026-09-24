import { describe, expect, it } from 'vitest'

import type { CueWord } from './schema'
import { segmentWords } from './segment'
import { assembleWords, isSpecialToken, parseWhisperJson, type WhisperJson } from './whisper'

/**
 * Build real JSON (through the parser) rather than a hand-made object, so these
 * tests exercise the zod schema too.
 *
 * Token specs are `[text, t_dtw]`; the leading space is significant, exactly as
 * whisper.cpp emits it, and `offsets` are deliberately all zeros — that is what
 * the real binary produces for interior tokens, and relying on them is the bug
 * this module exists to avoid.
 */
function build(segments: Array<{ from: number; tokens: Array<[string, number | null]> }>): WhisperJson {
  return parseWhisperJson(
    JSON.stringify({
      transcription: segments.map((s) => ({
        offsets: { from: s.from, to: s.from + 1000 },
        text: '',
        tokens: s.tokens.map(([text, t]) => ({
          text,
          offsets: { from: 0, to: 0 },
          id: 1,
          p: 0.9,
          ...(t === null ? {} : { t_dtw: t }),
        })),
      })),
    }),
  )
}

const texts = (words: CueWord[]) => words.map((w) => w.w)

describe('isSpecialToken', () => {
  it('recognises whisper special tokens', () => {
    expect(isSpecialToken('[_BEG_]')).toBe(true)
    expect(isSpecialToken(' [_TT_242]')).toBe(true)
    expect(isSpecialToken('<|endoftext|>')).toBe(true)
    expect(isSpecialToken(' hello')).toBe(false)
    expect(isSpecialToken('.')).toBe(false)
  })
})

describe('parseWhisperJson', () => {
  it('rejects something that is not whisper output', () => {
    expect(() => parseWhisperJson('{"nope":true}')).toThrow()
    expect(() => parseWhisperJson('not json')).toThrow()
  })

  it('accepts a segment with no tokens (-oj rather than -ojf)', () => {
    const json = parseWhisperJson('{"transcription":[{"offsets":{"from":0,"to":10},"text":"hi"}]}')
    expect(json.transcription[0].text).toBe('hi')
  })
})

describe('assembleWords', () => {
  it('glues punctuation and subword continuations onto their word', () => {
    const { words } = assembleWords(
      build([
        {
          from: 0,
          tokens: [
            ['[_BEG_]', -1],
            [' He', 10],
            ["'s", 12],
            [' here', 20],
            [',', 22],
            [' ok', 30],
          ],
        },
      ]),
    )
    // No space before the comma: "here ," would be a visible defect in every cue.
    expect(texts(words)).toEqual(["He's", 'here,', 'ok'])
    expect(words[0]).toMatchObject({ s: 0, e: 120 })
    expect(words[1]).toMatchObject({ s: 120, e: 220 })
  })

  it('reads t_dtw as each token END, not its start (measured, not guessed)', () => {
    // Ground truth came from the fixture's hand-verified VTT: the end reading
    // reproduces sentence boundaries to ~3ms, the start reading is ~80ms late.
    const { words } = assembleWords(
      build([
        {
          from: 700,
          tokens: [
            [' I', 78],
            [' moved', 92],
          ],
        },
      ]),
    )
    expect(words).toEqual([
      { w: 'I', s: 700, e: 780 },
      { w: 'moved', s: 780, e: 920 },
    ])
  })

  it('carries the DTW chain across segment boundaries', () => {
    // The second segment's own offsets.from (200) must not win: DTW is global,
    // and its boundary is the only thing that aligns the two segments.
    const { words } = assembleWords(
      build([
        { from: 0, tokens: [[' a', 10]] },
        { from: 200, tokens: [[' b', 30]] },
      ]),
    )
    expect(words[0]).toEqual({ w: 'a', s: 0, e: 100 })
    expect(words[1]).toEqual({ w: 'b', s: 100, e: 300 })
  })

  it('seeds the first word from the first segment offset, where DTW has no answer', () => {
    const { words } = assembleWords(build([{ from: 150, tokens: [[' hi', 20]] }]))
    expect(words[0].s).toBe(150)
  })

  it('caps a word so it cannot swallow a following pause', () => {
    // 800ms between the two DTW boundaries: with the cap the second word ends
    // at 800 and a 200ms gap survives for the segmenter to see.
    const json = build([{ from: 100, tokens: [[' Hello', 20], [' world', 100]] }])
    const capped = assembleWords(json)
    expect(capped.words[1]).toMatchObject({ s: 200, e: 800 })

    const uncapped = assembleWords(json, { maxWordMs: 2_000 })
    expect(uncapped.words[1]).toMatchObject({ s: 200, e: 1_000 })
  })

  it('ignores tokens with no DTW timing', () => {
    const { words } = assembleWords(build([{ from: 0, tokens: [[' hi', 10], [' there', null]] }]))
    expect(texts(words)).toEqual(['hi'])
  })

  it('reports when the JSON has no token data at all', () => {
    const result = assembleWords(build([{ from: 0, tokens: [] }]))
    expect(result.hasTokenTimings).toBe(false)
    expect(result.words).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/-ojf/)
  })

  it('counts the special tokens it dropped', () => {
    const { words, warnings } = assembleWords(
      build([{ from: 0, tokens: [['[_BEG_]', -1], [' hi', 10], ['[_TT_5]', -1]] }]),
    )
    expect(texts(words)).toEqual(['hi'])
    expect(warnings.join(' ')).toMatch(/2 whisper special token/)
  })
})

describe('whisper → segment, end to end on a synthetic transcript', () => {
  it('produces sentence cues with clean punctuation from raw tokens', () => {
    // Two sentences glued into one whisper segment, exactly the situation the
    // re-splitter exists for.
    const { words } = assembleWords(
      build([
        {
          from: 0,
          tokens: [
            [' I', 40],
            [' moved', 70],
            [' here', 100],
            [' last', 130],
            [' year', 160],
            ['.', 170],
            [' It', 200],
            [' was', 230],
            [' hard', 260],
            ['.', 270],
          ],
        },
      ]),
    )
    const { cues } = segmentWords(words)
    expect(cues.map((c) => c.text)).toEqual(['I moved here last year.', 'It was hard.'])
    expect(cues[0].words?.map((w) => w.w)).toEqual(['I', 'moved', 'here', 'last', 'year.'])
  })
})
