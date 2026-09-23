import type { Cue } from '@/lib/lesson/schema'

/**
 * The single hot lookup of the whole app: "which line is being spoken right now?"
 *
 * Called on every animation frame, so it must be O(log n) and allocation free.
 * It is a pure function of (cues, timeMs) — no React, no state, no closures.
 */

/** Index of the last cue whose start is <= timeMs, or -1 if timeMs is before the first cue. */
export function findCueIndexAtOrBefore(cues: readonly Cue[], timeMs: number): number {
  if (cues.length === 0) return -1
  if (timeMs < cues[0].start) return -1

  let low = 0
  let high = cues.length - 1
  let result = 0

  while (low <= high) {
    const mid = (low + high) >> 1
    if (cues[mid].start <= timeMs) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

/**
 * Index of the cue that should be highlighted, or -1 when we are in a gap
 * between two lines (silence, music, an intro).
 */
export function findActiveCueIndex(cues: readonly Cue[], timeMs: number): number {
  const index = findCueIndexAtOrBefore(cues, timeMs)
  if (index === -1) return -1
  return timeMs < cues[index].end ? index : -1
}

/** Index of the next cue starting after timeMs — used by "jump to next line". */
export function findNextCueIndex(cues: readonly Cue[], timeMs: number): number {
  const index = findCueIndexAtOrBefore(cues, timeMs)
  const candidate = index + 1
  return candidate < cues.length ? candidate : cues.length - 1
}

/** Index of the previous cue — used by "jump to previous line". */
export function findPreviousCueIndex(cues: readonly Cue[], timeMs: number): number {
  // Matches findNextCueIndex: an empty transcript has no line to land on, so
  // callers can uniformly test for a negative index.
  if (cues.length === 0) return -1
  const index = findCueIndexAtOrBefore(cues, timeMs)
  if (index <= 0) return 0
  // If we are more than 400ms into the current line, restart it instead of
  // stepping back one — this matches how people expect "back" to behave.
  return timeMs - cues[index].start > 400 ? index : index - 1
}
