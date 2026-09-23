import { describe, expect, it } from 'vitest'

import { makeCue, type Cue } from '@/lib/lesson/schema'
import {
  findActiveCueIndex,
  findCueIndexAtOrBefore,
  findNextCueIndex,
  findPreviousCueIndex,
} from './findActiveCue'

/**
 * Three lines with deliberate gaps between them, which is where the interesting
 * bugs live: the highlight must go out during silence rather than sticking to
 * the previous line.
 */
const cues: Cue[] = [
  makeCue({ id: 0, start: 1000, end: 2000, text: 'first' }),
  makeCue({ id: 1, start: 2500, end: 3000, text: 'second' }),
  makeCue({ id: 2, start: 6000, end: 7000, text: 'third' }),
]

describe('findCueIndexAtOrBefore', () => {
  it('returns -1 for an empty transcript', () => {
    expect(findCueIndexAtOrBefore([], 5000)).toBe(-1)
  })

  it('returns -1 before the first cue starts', () => {
    expect(findCueIndexAtOrBefore(cues, 0)).toBe(-1)
    expect(findCueIndexAtOrBefore(cues, 999)).toBe(-1)
  })

  it('returns the cue that is open at the given time', () => {
    expect(findCueIndexAtOrBefore(cues, 1000)).toBe(0)
    expect(findCueIndexAtOrBefore(cues, 1999)).toBe(0)
    expect(findCueIndexAtOrBefore(cues, 2500)).toBe(1)
  })

  it('keeps returning the previous cue during a gap', () => {
    // 2100 is silent, but cue 0 is still the last cue that had started.
    expect(findCueIndexAtOrBefore(cues, 2100)).toBe(0)
    expect(findCueIndexAtOrBefore(cues, 2499)).toBe(0)
  })

  it('returns the last cue for any time past the end', () => {
    expect(findCueIndexAtOrBefore(cues, 999_999)).toBe(2)
  })
})

describe('findActiveCueIndex', () => {
  it('is -1 for an empty transcript', () => {
    expect(findActiveCueIndex([], 1500)).toBe(-1)
  })

  it('highlights the cue currently being spoken', () => {
    expect(findActiveCueIndex(cues, 1500)).toBe(0)
    expect(findActiveCueIndex(cues, 2600)).toBe(1)
    expect(findActiveCueIndex(cues, 6500)).toBe(2)
  })

  it('treats the cue end as exclusive', () => {
    // The moment a cue ends we are between lines; keeping it highlighted is
    // what makes the "sticky highlight" bug visible to a listener.
    expect(findActiveCueIndex(cues, 2000)).toBe(-1)
    expect(findActiveCueIndex(cues, 3000)).toBe(-1)
  })

  it('goes dark during silence between lines', () => {
    expect(findActiveCueIndex(cues, 2200)).toBe(-1)
    expect(findActiveCueIndex(cues, 5000)).toBe(-1)
    expect(findActiveCueIndex(cues, 999_999)).toBe(-1)
  })

  it('highlights the first cue on its very first millisecond', () => {
    expect(findActiveCueIndex(cues, 1000)).toBe(0)
  })
})

describe('findNextCueIndex', () => {
  it('moves to the following line', () => {
    expect(findNextCueIndex(cues, 1500)).toBe(1)
    expect(findNextCueIndex(cues, 2600)).toBe(2)
  })

  it('jumps to the first line when playhead is before the transcript', () => {
    expect(findNextCueIndex(cues, 0)).toBe(0)
  })

  it('clamps to the last line instead of running off the end', () => {
    expect(findNextCueIndex(cues, 6500)).toBe(2)
    expect(findNextCueIndex(cues, 999_999)).toBe(2)
  })

  it('returns -1 only for an empty transcript', () => {
    expect(findNextCueIndex([], 1500)).toBe(-1)
  })
})

describe('findPreviousCueIndex', () => {
  it('restarts the current line when we are already into it', () => {
    // More than 400ms in, "back" means "replay this line", not "go up one".
    expect(findPreviousCueIndex(cues, 3000)).toBe(1)
    expect(findPreviousCueIndex(cues, 6500)).toBe(2)
  })

  it('steps back a line when the current one has barely started', () => {
    expect(findPreviousCueIndex(cues, 2500)).toBe(0)
    expect(findPreviousCueIndex(cues, 2700)).toBe(0)
  })

  it('never goes below the first line', () => {
    expect(findPreviousCueIndex(cues, 0)).toBe(0)
    expect(findPreviousCueIndex(cues, 1500)).toBe(0)
  })

  it('returns -1 only for an empty transcript', () => {
    expect(findPreviousCueIndex([], 1500)).toBe(-1)
  })
})
