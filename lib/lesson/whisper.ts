import { z } from 'zod'

import type { CueWord } from './schema'

/**
 * Reader for `whisper-cli -ojf -dtw` output.
 *
 * Three things here are not obvious, and all three were measured rather than
 * assumed (see PROGRESS §15):
 *
 * 1. **`offsets` are unreliable; `t_dtw` is the real timing.** whisper.cpp gives
 *    every token an `offsets.from/to`, but interior tokens routinely come back
 *    degenerate (`from === to`), and each segment's `offsets.from` includes the
 *    leading silence before its first word. With `-dtw` each token also carries
 *    `t_dtw`: a global frame counter in 10ms units.
 *
 * 2. **`t_dtw` marks a token's END, not its start.** Checked against the
 *    fixture's hand-verified VTT: reading it as the end reproduces sentence
 *    boundaries to within 3ms, reading it as the start is consistently ~80ms
 *    late. So a token spans [previous token's `t_dtw`, this token's `t_dtw`].
 *
 * 3. **`--vad` moves the token timings into a different timeline.** VAD makes
 *    the engine recognise a *concatenation of the speech chunks*, so the token
 *    positions describe "position within speech" — the leading silence is gone
 *    from the counter and every silence in the file has been removed from it.
 *    Meanwhile each segment's own `offsets` stay in the original audio. On the
 *    fixture the token timeline covers only 94.7% of the audio, and the gap
 *    between the two timelines grows monotonically (700ms → 6420ms), which is
 *    the tell that silence is being *deleted* rather than time compressed. Each
 *    segment's tokens are therefore translated by that segment's own offset —
 *    see the anchor comment in `assembleWords`.
 *
 * Consequence of (2): the pause between two words is carried by the *earlier*
 * word's span, which is why `maxWordMs` exists — without a cap, a trailing "."
 * would swallow a three-second silence and the segmenter's gap rules would never
 * see a pause again.
 *
 * All three of these are silent failures. None of them throws; the transcript
 * still reads perfectly. They only show up as boundaries that are uniformly
 * wrong, which is why `npm run bench:asr` reports *signed* error per cue: a
 * median of absolute values cannot tell a noisy-but-honest 100ms from a
 * systematically early 550ms, and those two need different responses.
 */

const tokenSchema = z.object({
  text: z.string(),
  offsets: z.object({ from: z.number(), to: z.number() }),
  id: z.number().optional(),
  p: z.number().optional(),
  t_dtw: z.number().optional(),
})

const segmentSchema = z.object({
  offsets: z.object({ from: z.number(), to: z.number() }),
  text: z.string().default(''),
  tokens: z.array(tokenSchema).optional(),
})

const whisperJsonSchema = z.object({
  systeminfo: z.string().optional(),
  model: z.object({ type: z.string().optional(), multilingual: z.boolean().optional() }).partial().optional(),
  params: z.object({ model: z.string().optional(), language: z.string().optional() }).partial().optional(),
  result: z.object({ language: z.string().optional() }).partial().optional(),
  transcription: z.array(segmentSchema),
})

export type WhisperToken = z.infer<typeof tokenSchema>
export type WhisperSegment = z.infer<typeof segmentSchema>
export type WhisperJson = z.infer<typeof whisperJsonSchema>

export type AssembleOptions = {
  /**
   * Longest span any word may hold. Caps how much *following* silence a word
   * (usually the punctuation attached to it) is allowed to absorb, so real
   * pauses survive as gaps for the segmenter's rules 2 and 3 to see.
   */
  maxWordMs: number
  /**
   * Set this when `whisper-cli` was run with `--vad`. The JSON does not record
   * whether it was, so it cannot be inferred from the payload alone — get it
   * wrong and every cue drifts. Leaving this false for a `--vad` run shifts
   * timings early by all the silence skipped so far (so the error grows through
   * the file, and the first cue can be off by ~700ms).
   */
  vad: boolean
}

export const DEFAULT_ASSEMBLE_OPTIONS: AssembleOptions = { maxWordMs: 600, vad: false }

/**
 * Below this, the token timeline covers so much less than the audio that the run
 * must have skipped silence — i.e. `--vad` was used. Measured: 1.000 without VAD,
 * 0.947 with it.
 */
const VAD_TIMELINE_RATIO = 0.99

export type AssembleResult = {
  words: CueWord[]
  warnings: string[]
  /**
   * false when the JSON came from `-oj` rather than `-ojf`: there are segments
   * but no per-token data, so no word timeline can be built.
   */
  hasTokenTimings: boolean
}

export function parseWhisperJson(raw: string): WhisperJson {
  return whisperJsonSchema.parse(JSON.parse(raw))
}

/**
 * `[_BEG_]`, `[_TT_242]`, `<|endoftext|>` — not speech.
 *
 * The trailing `_` is deliberately optional: whisper.cpp writes timestamp
 * tokens as `[_TT_242]`, which ends in digits. Requiring `_]` (as the other
 * specials use) silently lets every timestamp token through into the text.
 */
export function isSpecialToken(text: string): boolean {
  const trimmed = text.trim()
  return /^\[_[A-Za-z0-9_]*\]$/.test(trimmed) || /^<\|.*\|>$/.test(trimmed)
}

/**
 * A token that carries no letters or digits: "." "," "'" "♪". Punctuation
 * arrives as its own token and must be glued to the word it follows, with no
 * space — otherwise every cue reads "home ." instead of "home.".
 */
function isPunctuationOnly(text: string): boolean {
  return /^[^\p{L}\p{N}]+$/u.test(text)
}

export function assembleWords(
  json: WhisperJson,
  options: Partial<AssembleOptions> = {},
): AssembleResult {
  const opts = { ...DEFAULT_ASSEMBLE_OPTIONS, ...options }
  const warnings: string[] = []

  const hasTokenTimings = json.transcription.some((segment) => (segment.tokens?.length ?? 0) > 0)
  if (!hasTokenTimings) {
    return {
      words: [],
      hasTokenTimings: false,
      warnings: [
        'No per-token timings in the whisper JSON — re-run with -ojf (and -dtw) to get a word timeline.',
      ],
    }
  }

  const words: CueWord[] = []
  let current: CueWord | null = null
  let droppedSpecial = 0
  /** Last boundary seen in the previous segment; see `start` below. */
  let previousSegmentBoundary: number | null = null
  let timelineEnd = 0
  let audioEnd = 0

  const flush = () => {
    if (current && current.w.length > 0) words.push(current)
    current = null
  }

  for (const segment of json.transcription) {
    audioEnd = Math.max(audioEnd, segment.offsets.to)

    const timed: WhisperToken[] = []
    for (const token of segment.tokens ?? []) {
      if (isSpecialToken(token.text)) {
        droppedSpecial += 1
        continue
      }
      if (!(typeof token.t_dtw === 'number' && token.t_dtw >= 0)) continue
      if (token.text.trim().length === 0) continue
      timed.push(token)
    }
    if (timed.length === 0) continue

    const positions = timed.map((token) => token.t_dtw! * 10)
    timelineEnd = Math.max(timelineEnd, positions[positions.length - 1])

    // With --vad, positions live in the speech-only timeline and the segment's
    // offsets live in the audio. VAD *deletes* silence, it does not change
    // speaking rate, so the two timelines differ by an offset that is constant
    // within a segment and grows across the file — measured 700ms at segment 0
    // rising monotonically to 6420ms at the last one, i.e. exactly the silence
    // removed so far. A linear rescale onto [offsets.from, offsets.to] would
    // additionally stretch every inter-token duration by the span ratio
    // (measured 1.09 at the median), which would be audible nonsense.
    //
    // Anchoring: the first token maps onto `offsets.from`, which the no-VAD run
    // showed is where whisper puts a segment's first token anyway
    // (`offsets.from - posFirst` is 0ms at the median there). That leaves the
    // segment's very first word with no measurable duration of its own — the
    // one real cost of this mapping, and `segment.ts` already normalizes it.
    const shift = segment.offsets.from - positions[0]
    const toAbsolute = (position: number): number => (opts.vad ? position + shift : position)

    let segmentBoundary: number | null = null

    timed.forEach((token, index) => {
      const boundary = toAbsolute(positions[index])
      const start =
        index === 0
          ? opts.vad
            ? // The segment's own offset is the true speech onset, and the gap
              // since the previous segment is real silence we must not swallow.
              segment.offsets.from
            : // Without VAD the chain is continuous; the previous segment's last
              // boundary is the correct start (measured to 3ms).
              (previousSegmentBoundary ?? segment.offsets.from)
          : (segmentBoundary ?? boundary)
      const end = Math.min(boundary, start + opts.maxWordMs)
      segmentBoundary = boundary

      const text = token.text
      const trimmed = text.trim()
      const startsNewWord = /^\s/.test(text)

      if (current && (!startsNewWord || isPunctuationOnly(trimmed))) {
        // Subword continuation ("n't", "'s") or trailing punctuation.
        current.w += trimmed
        current.e = end
      } else {
        flush()
        current = { w: trimmed, s: start, e: end }
      }
    })

    flush()
    if (segmentBoundary !== null) previousSegmentBoundary = segmentBoundary
  }

  if (droppedSpecial > 0) {
    warnings.push(`Ignored ${droppedSpecial} whisper special token(s).`)
  }

  // A `vad` that disagrees with the flags actually used is silent corruption of
  // every timestamp, so say so rather than trusting the caller.
  const coverage = audioEnd > 0 ? timelineEnd / audioEnd : 1
  if (coverage < VAD_TIMELINE_RATIO && !opts.vad) {
    warnings.push(
      `Token timings cover only ${(coverage * 100).toFixed(0)}% of the audio, which means this run used --vad: ` +
        'pass { vad: true } or every cue will be shifted early.',
    )
  } else if (coverage >= VAD_TIMELINE_RATIO && opts.vad) {
    warnings.push(
      `vad:true was passed but the token timings cover the whole audio (${(coverage * 100).toFixed(0)}%), ` +
        'which means --vad was probably not used: the timings are already absolute.',
    )
  }

  const inverted = words.filter((word, i) => i > 0 && word.s < words[i - 1].e).length
  if (inverted > 0) {
    warnings.push(`${inverted} word(s) overlap the previous word; the segmenter will normalize them.`)
  }

  return { words, warnings, hasTokenTimings: true }
}
