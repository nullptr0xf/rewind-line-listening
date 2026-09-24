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
 *
 * `to` defaults to a second after `from`; VAD tests set it deliberately to
 * simulate the padding a real VAD segment carries beyond its last token.
 */
function build(
  segments: Array<{ from: number; to?: number; tokens: Array<[string, number | null]> }>,
): WhisperJson {
  return parseWhisperJson(
    JSON.stringify({
      transcription: segments.map((s) => ({
        offsets: { from: s.from, to: s.to ?? s.from + 1000 },
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

/**
 * With `--vad` the token positions live in whisper's speech-only timeline while
 * `offsets` stay in the audio, so the two have to be reconciled. The reconciler
 * is a *translation*, not a rescale — measured on the real fixture, the gap
 * between the timelines grows monotonically (700ms → 6420ms, i.e. exactly the
 * silence deleted so far) while the segment span exceeds the token span by a
 * median factor of 1.09.
 */
describe('assembleWords with --vad', () => {
  it('translates a segment by a constant offset instead of rescaling it', () => {
    // `to` is 9x the token span. A rescale would multiply every inter-token gap
    // by 9 (100ms → 900ms); a translation leaves them alone. Silence removal
    // deletes time, it does not change speaking rate.
    const { words } = assembleWords(
      build([{ from: 5_000, to: 14_000, tokens: [[' a', 100], [' b', 110], [' c', 120]] }]),
      { vad: true },
    )
    const gaps = words.slice(1).map((w, i) => w.e - words[i].e)
    expect(gaps).toEqual([100, 100])
    expect(words[words.length - 1].e).toBe(5_200)
  })

  it("starts a segment's first word at that segment's own offset, keeping the pause", () => {
    // 7s of real silence sits between the two utterances. Chaining to the
    // previous segment's boundary would swallow all of it; the offset keeps it.
    const { words } = assembleWords(
      build([
        { from: 1_000, to: 2_000, tokens: [[' a', 100]] },
        { from: 9_000, to: 10_000, tokens: [[' b', 200]] },
      ]),
      { vad: true },
    )
    expect(words[1].s).toBe(9_000)
  })

  it('leaves the offsets alone when vad is not set', () => {
    // Without VAD the token timeline *is* the audio timeline — measured coverage
    // 0.9998 — so translating here would corrupt every timestamp.
    const { words } = assembleWords(
      build([{ from: 1_000, to: 2_000, tokens: [[' a', 100], [' b', 110]] }]),
    )
    expect(words.map((w) => w.e)).toEqual([1_000, 1_100])
  })

  it('leaves a VAD segment its first word with no measurable duration', () => {
    // The known cost of anchoring at `offsets.from`: only one anchor is known
    // for the segment's first token, so its end lands on its own start. Pinned
    // here so a future reader sees it is understood, not overlooked —
    // `segment.ts` normalizes it when building cues.
    const { words } = assembleWords(
      build([{ from: 5_000, to: 6_000, tokens: [[' a', 100], [' b', 150]] }]),
      { vad: true },
    )
    expect(words[0]).toMatchObject({ s: 5_000, e: 5_000 })
    expect(words[1]).toMatchObject({ s: 5_000, e: 5_500 })
  })

  it('warns when a run clearly used --vad but was not told so', () => {
    // Token timeline covers 11% of the audio: the signature of skipped silence.
    const { warnings } = assembleWords(build([{ from: 8_000, to: 9_000, tokens: [[' hi', 100]] }]))
    expect(warnings.join(' ')).toMatch(/used --vad/)
  })

  it('warns when told --vad for a run that plainly did not use it', () => {
    const { warnings } = assembleWords(build([{ from: 0, to: 1_000, tokens: [[' hi', 100]] }]), {
      vad: true,
    })
    expect(warnings.join(' ')).toMatch(/already absolute/)
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

  it('absorbs a degenerate VAD first word into a usable cue', () => {
    // The VAD anchor leaves the segment's first word zero-length; the segmenter
    // is what makes that harmless, so this asserts the two modules agree.
    const { words } = assembleWords(
      build([{ from: 5_000, to: 6_000, tokens: [[' Hello', 100], [' there', 150], [' friend', 200]] }]),
      { vad: true },
    )
    const { cues } = segmentWords(words)
    expect(cues).toHaveLength(1)
    expect(cues[0].start).toBe(5_000)
    expect(cues[0].text).toBe('Hello there friend')
  })
})
