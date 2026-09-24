import { makeCue, type Cue, type CueWord } from './schema'

/**
 * Sentence re-splitter (design doc §4.4). The most important function in the
 * project: Whisper emits ~30-second acoustic windows, not sentences, and a
 * repeat-listening trainer is only usable when one cue is one spoken sentence.
 *
 * Pure, no I/O, no clock. The only input shape is CueWord[] — so it does not
 * matter whether the words came from whisper.cpp tokens (`-ojf -dtw`), from a
 * forced aligner, or from the word-boundary timeline the fixture already has.
 * That keeps the ASR route decision out of this file entirely.
 */

export type SegmentOptions = {
  /** Split anything longer than this (doc: 12~15s). */
  maxDurMs: number
  /** Chunks shorter than this are folded into a neighbour (doc: 1.0s). */
  minDurMs: number
  /** Chunks with fewer words than this are folded into a neighbour (doc: 3). */
  minWords: number
  /** A silence this long always ends a sentence, punctuation or not (doc: 600~800ms). */
  gapMs: number
  /** `,` `;` `:` plus a silence this long also ends a sentence (doc: 300ms). */
  weakGapMs: number
  /**
   * Keep a short chunk that ends in `.` `?` `!` instead of folding it away.
   *
   * Deviation from the doc, deliberately. The doc's rule 4 folds every chunk
   * under minDur/minWords into a neighbour, which glues "Yes." onto the end of
   * the previous sentence and misrepresents two utterances as one. A short
   * sentence that actually terminated is a real sentence; a short cue is cheap
   * (per-cue loop makes it useful for shadowing), a wrong cue is not.
   */
  keepShortSentences: boolean
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  maxDurMs: 12_000,
  minDurMs: 1_000,
  minWords: 3,
  gapMs: 700,
  weakGapMs: 300,
  keepShortSentences: true,
}

/**
 * whisper.cpp reports a timing for every token, and some of those timings are
 * degenerate (`from === to`) — a word with no measurable span. A cue also must
 * have a positive duration or the player's per-cue loop has nothing to seek to,
 * so every cue gets floored to this.
 */
const MIN_CUE_MS = 400

/**
 * Abbreviations whose trailing period must NOT be read as a sentence end.
 * Without this, "Mr." / "U.S." / "etc." each split a sentence in half.
 */
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'mt.',
  'inc.', 'ltd.', 'co.', 'corp.', 'etc.', 'e.g.', 'i.e.', 'vs.', 'no.',
  'fig.', 'approx.', 'dept.', 'min.', 'max.',
  'u.s.', 'u.k.', 'u.n.', 'a.m.', 'p.m.', 'ph.d.', 'b.c.', 'a.d.',
])

export type EndingKind = 'strong' | 'weak' | 'none'

/**
 * Classify how a word ends. `strong` terminates a sentence, `weak` terminates
 * only if a pause follows, `none` never does.
 *
 * English traps this has to survive (doc §4.4): abbreviations, initials
 * (`John F. Kennedy`), dotted acronyms (`U.S.A.`), decimals and version numbers
 * (`3.14`, `v2.0` — both protected already, because the character after the
 * period is a digit, so the period is not the token's last character) — and an
 * ellipsis, which per the doc *should* break.
 *
 * One trap was removed rather than added: a trailing "10." used to be treated
 * as a numbered-list marker and never ended a sentence. That glued
 * "…the streets are after 10." onto the sentence after it, which no unit test
 * caught and one end-to-end run against real whisper output did.
 */
export function classifyEnding(raw: string): EndingKind {
  // Strip closing quotes/brackets so `said."` is judged on the period.
  // NOTE: `…` is deliberately NOT stripped — it is the terminator being tested.
  let token = raw.trim()
  while (token.length > 0 && /["'”’»)\]}]$/.test(token)) token = token.slice(0, -1)
  if (token.length === 0) return 'none'

  if (/(?:\.{3,}|…)$/.test(token)) return 'strong'

  const last = token[token.length - 1]
  if (last === '?' || last === '!') return 'strong'
  if (last === ',' || last === ';' || last === ':') return 'weak'
  if (last !== '.') return 'none'

  const withDot = `${token.slice(0, -1).toLowerCase()}.`
  if (ABBREVIATIONS.has(withDot)) return 'none'
  if (/^[a-z]\.$/.test(withDot)) return 'none' // initial: "J."
  if (/^(?:[a-z]\.){2,}$/.test(withDot)) return 'none' // acronym: "U.S.A."
  return 'strong'
}

/** Word index range, half-open: words[from] .. words[to - 1]. */
type Chunk = { from: number; to: number }

export type SegmentResult = {
  cues: Cue[]
  /** Non-fatal decisions worth surfacing in the ingest report. */
  warnings: string[]
}

/** The three knobs that get persisted into lesson.json's transcript.segmentation. */
export function segmentationRecord(options: SegmentOptions): {
  maxDurMs: number
  minDurMs: number
  gapMs: number
} {
  return { maxDurMs: options.maxDurMs, minDurMs: options.minDurMs, gapMs: options.gapMs }
}

export function segmentWords(
  input: CueWord[],
  options: Partial<SegmentOptions> = {},
): SegmentResult {
  const opts = { ...DEFAULT_SEGMENT_OPTIONS, ...options }
  const warnings: string[] = []

  const words = normalizeWords(input, warnings)
  if (words.length === 0) return { cues: [], warnings }

  const chunks = splitLongChunks(words, mergeShortChunks(words, splitOnBoundaries(words, opts), opts), opts)
  const cues = finalize(words, chunks, warnings)

  return { cues, warnings }
}

/**
 * Trust the producer's order but guarantee the invariants the rest of the
 * pipeline assumes: integer, non-negative, duration > 0, non-decreasing start.
 */
function normalizeWords(input: CueWord[], warnings: string[]): CueWord[] {
  const out: CueWord[] = []
  let droppedEmpty = 0
  let repaired = 0

  for (const word of input) {
    const text = word.w.trim()
    if (text.length === 0) {
      droppedEmpty += 1
      continue
    }
    let start = Math.max(0, Math.round(word.s))
    let end = Math.max(0, Math.round(word.e))
    if (end < start) {
      end = start
      repaired += 1
    }
    const previous = out[out.length - 1]
    if (previous && start < previous.s) {
      start = previous.s
      if (end < start) end = start
      repaired += 1
    }
    out.push({ w: text, s: start, e: end })
  }

  if (droppedEmpty > 0) warnings.push(`Dropped ${droppedEmpty} empty word token(s).`)
  if (repaired > 0) {
    warnings.push(`Repaired ${repaired} out-of-order or inverted word timestamp(s).`)
  }
  return out
}

function gapAfter(words: CueWord[], index: number): number {
  const next = words[index + 1]
  if (!next) return 0
  return Math.max(0, next.s - words[index].e)
}

/**
 * Rules 1-3: cut wherever the text ends a sentence, wherever a long silence
 * sits, or wherever weak punctuation is followed by a short silence.
 */
function splitOnBoundaries(words: CueWord[], opts: SegmentOptions): Chunk[] {
  const chunks: Chunk[] = []
  let start = 0

  for (let i = 0; i < words.length - 1; i += 1) {
    const ending = classifyEnding(words[i].w)
    const gap = gapAfter(words, i)
    const cut =
      ending === 'strong' ||
      gap > opts.gapMs ||
      (ending === 'weak' && gap > opts.weakGapMs)
    if (cut) {
      chunks.push({ from: start, to: i + 1 })
      start = i + 1
    }
  }
  chunks.push({ from: start, to: words.length })
  return chunks
}

function chunkSpan(words: CueWord[], chunk: Chunk): number {
  return words[chunk.to - 1].e - words[chunk.from].s
}

/**
 * Rule 4: fold fragments into a neighbour.
 *
 * A fragment is a chunk that is too short *and* never terminated a sentence —
 * i.e. Whisper's "And" / "So," / "the next" debris. See `keepShortSentences`
 * for why a terminated short sentence is left alone.
 */
function mergeShortChunks(words: CueWord[], chunks: Chunk[], opts: SegmentOptions): Chunk[] {
  const isFragment = (chunk: Chunk): boolean => {
    const count = chunk.to - chunk.from
    if (count <= 0) return true
    const terminated = classifyEnding(words[chunk.to - 1].w) === 'strong'
    if (terminated && opts.keepShortSentences) return false
    return chunkSpan(words, chunk) < opts.minDurMs || count < opts.minWords
  }

  const out: Chunk[] = []
  for (const chunk of chunks) {
    const previous = out[out.length - 1]
    if (previous && isFragment(chunk)) {
      previous.to = chunk.to
    } else {
      out.push({ from: chunk.from, to: chunk.to })
    }
  }

  // A fragment opening the audio has nothing behind it to merge into, so it
  // merges forward instead of becoming a stray one-word cue.
  if (out.length > 1 && isFragment(out[0])) {
    out[1].from = out[0].from
    out.shift()
  }
  return out
}

/** Rule 5: cut over-long chunks again, at the best pause near the middle. */
function splitLongChunks(words: CueWord[], chunks: Chunk[], opts: SegmentOptions): Chunk[] {
  const out: Chunk[] = []
  for (const chunk of chunks) out.push(...splitChunk(words, chunk, opts, 0))
  return out
}

function splitChunk(words: CueWord[], chunk: Chunk, opts: SegmentOptions, depth: number): Chunk[] {
  const count = chunk.to - chunk.from
  if (count <= 1) return [chunk]
  if (chunkSpan(words, chunk) <= opts.maxDurMs) return [chunk]
  // Defensive: a pathological chunk must not recurse forever.
  if (depth > 12) return [chunk]

  const index = pickSplitIndex(words, chunk, opts)
  if (index === null) return [chunk]

  return [
    ...splitChunk(words, { from: chunk.from, to: index }, opts, depth + 1),
    ...splitChunk(words, { from: index, to: chunk.to }, opts, depth + 1),
  ]
}

/**
 * Choose where to re-cut an over-long chunk.
 *
 * The acoustic signal is the pause, so the biggest gap wins; but a big pause
 * 400ms from the start of a 13-second chunk produces a 0.4s cue, so candidates
 * are ranked with the balance of the two halves as a tie-break and the central
 * half of the chunk is preferred. Weak punctuation (a comma) is the last
 * tie-break, which is the doc's "or split at the comma".
 */
function pickSplitIndex(words: CueWord[], chunk: Chunk, opts: SegmentOptions): number | null {
  const start = words[chunk.from].s
  const end = words[chunk.to - 1].e
  const middle = (start + end) / 2
  const centralWindow = (end - start) / 4

  type Candidate = {
    index: number
    gap: number
    distance: number
    /** Splitting here does not strand a sliver on either side. */
    viable: boolean
    /** The word before this boundary ends in `,` `;` `:` — the doc's "or a comma". */
    weakPunct: boolean
  }
  const candidates: Candidate[] = []

  for (let i = chunk.from + 1; i < chunk.to; i += 1) {
    const at = words[i].s
    candidates.push({
      index: i,
      gap: gapAfter(words, i - 1),
      distance: Math.abs(at - middle),
      viable: words[i - 1].e - start >= opts.minDurMs && end - at >= opts.minDurMs,
      weakPunct: classifyEnding(words[i - 1].w) === 'weak',
    })
  }
  if (candidates.length === 0) return null

  const central = candidates.filter((c) => c.distance <= centralWindow)
  const viable = candidates.filter((c) => c.viable)
  const pool =
    [central.filter((c) => c.viable), central, viable, candidates].find((p) => p.length > 0) ?? []

  let best = pool[0]
  for (const candidate of pool) {
    if (candidate.gap > best.gap) {
      best = candidate
    } else if (candidate.gap === best.gap) {
      if (candidate.distance < best.distance) {
        best = candidate
      } else if (candidate.distance === best.distance && candidate.weakPunct && !best.weakPunct) {
        best = candidate
      }
    }
  }
  return best.index
}

/** Rule 6: recompute start/end, floor degenerate cues, guarantee monotonicity. */
function finalize(words: CueWord[], chunks: Chunk[], warnings: string[]): Cue[] {
  const staged = chunks
    .filter((chunk) => chunk.to > chunk.from)
    .map((chunk) => {
      const members = words.slice(chunk.from, chunk.to)
      const start = members[0].s
      const end = members[members.length - 1].e
      return {
        start,
        end: Math.max(end, start + MIN_CUE_MS),
        floored: end < start + MIN_CUE_MS,
        text: members.map((word) => word.w).join(' '),
        words: members.map((word) => ({ w: word.w, s: word.s, e: word.e })),
      }
    })

  const out: Array<(typeof staged)[number]> = []
  let floored = 0
  let absorbed = 0
  let trimmed = 0

  for (const cue of staged) {
    if (cue.floored) floored += 1
    const previous = out[out.length - 1]
    if (previous && previous.end > cue.start) {
      // Two options when a floored cue overlaps the next one: give back the
      // overhang, or — if that would leave the previous cue too thin to play —
      // accept that these two cannot be separated and merge them.
      if (cue.start - previous.start >= MIN_CUE_MS) {
        previous.end = cue.start
        trimmed += 1
      } else {
        previous.end = Math.max(previous.end, cue.end)
        previous.text = `${previous.text} ${cue.text}`.trim()
        previous.words = [...previous.words, ...cue.words]
        absorbed += 1
        continue
      }
    }
    out.push(cue)
  }

  if (floored > 0) {
    warnings.push(`Gave ${floored} cue(s) a minimum ${MIN_CUE_MS}ms span (Whisper timings can be zero-length).`)
  }
  if (trimmed > 0) {
    warnings.push(`Trimmed ${trimmed} overlapping cue(s) so only one line can be active at a time.`)
  }
  if (absorbed > 0) {
    warnings.push(`Merged ${absorbed} cue(s) that could not be separated from their neighbour in time.`)
  }

  return out.map((cue, index) =>
    makeCue({ id: index, start: cue.start, end: cue.end, text: cue.text, words: cue.words }),
  )
}
