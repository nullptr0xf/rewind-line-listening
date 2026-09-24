import { z } from 'zod'

import type { CueWord } from './schema'

/**
 * Reader for `whisper-cli -ojf -dtw` output.
 *
 * Two things here are not obvious, and both were measured rather than assumed
 * (see PROGRESS §15):
 *
 * 1. **`offsets` are unreliable; `t_dtw` is the real timing.** whisper.cpp gives
 *    every token an `offsets.from/to`, but interior tokens routinely come back
 *    degenerate (`from === to`), and each segment's `offsets.from` includes the
 *    leading silence before its first word. With `-dtw` each token also carries
 *    `t_dtw`, a global (not per-segment) frame counter in 10ms units.
 *
 * 2. **`t_dtw` marks a token's END, not its start.** Checked against the
 *    fixture's hand-verified VTT: reading it as the end reproduces sentence
 *    boundaries to within 3ms, reading it as the start is consistently ~80ms
 *    late. So a token spans [previous token's `t_dtw`, this token's `t_dtw`].
 *
 * Consequence: the pause between two words is carried by the *earlier* word's
 * span, which is why `maxWordMs` exists — without a cap, a trailing "." would
 * swallow a three-second silence and the segmenter's gap rules would never see
 * a pause again.
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
}

export const DEFAULT_ASSEMBLE_OPTIONS: AssembleOptions = { maxWordMs: 600 }

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

  /**
   * Where the next token starts. Seeded from the first segment's offset because
   * the very first token has no predecessor in the DTW chain — and that offset
   * includes the leading silence, which is the one place DTW cannot help.
   */
  let cursor = json.transcription[0]?.offsets.from ?? 0

  const flush = () => {
    if (current && current.w.length > 0) words.push(current)
    current = null
  }

  for (const segment of json.transcription) {
    for (const token of segment.tokens ?? []) {
      if (isSpecialToken(token.text)) {
        droppedSpecial += 1
        continue
      }
      if (!(typeof token.t_dtw === 'number' && token.t_dtw >= 0)) {
        // No DTW timing for this token; nothing sensible to attribute to it.
        continue
      }

      const text = token.text
      const trimmed = text.trim()
      if (trimmed.length === 0) continue

      const boundary = token.t_dtw * 10
      const start = cursor
      const end = Math.min(boundary, start + opts.maxWordMs)
      cursor = boundary

      const startsNewWord = /^\s/.test(text)
      if (current && (!startsNewWord || isPunctuationOnly(trimmed))) {
        // Subword continuation ("n't", "'s") or trailing punctuation.
        current.w += trimmed
        current.e = end
      } else {
        flush()
        current = { w: trimmed, s: start, e: end }
      }
    }
    // A segment's final token may leave the cursor short of the segment end;
    // keep the chain on DTW boundaries rather than snapping to offsets.
  }
  flush()

  if (droppedSpecial > 0) {
    warnings.push(`Ignored ${droppedSpecial} whisper special token(s).`)
  }

  // DTW is monotonic, but a capped word can still end up after the next one
  // starts; normalizeWords in the segmenter repairs that, so just report it.
  const inverted = words.filter((word, i) => i > 0 && word.s < words[i - 1].e).length
  if (inverted > 0) {
    warnings.push(`${inverted} word(s) overlap the previous word; the segmenter will normalize them.`)
  }

  return { words, warnings, hasTokenTimings: true }
}
