import { describe, expect, it } from 'vitest'

import type { CueWord } from './schema'
import {
  DEFAULT_SEGMENT_OPTIONS,
  classifyEnding,
  segmentWords,
  segmentationRecord,
} from './segment'

/**
 * Word specs are written as `text:start-end` (milliseconds) because the rules
 * below are all about *timing*, and a literal CueWord[] buries that in noise.
 * Real producers hand us punctuation attached to the word (see whisper.ts), so
 * that is the default shape here too.
 */
function words(spec: string): CueWord[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => {
      const match = /^(.*):(\d+)-(\d+)$/.exec(chunk)
      if (!match) throw new Error(`bad word spec: ${chunk}`)
      return { w: match[1], s: Number(match[2]), e: Number(match[3]) }
    })
}

/** Continuous speech: `count` words, no sentence punctuation, small gaps. */
function chatter(count: number, stepMs = 400, speechMs = 350): CueWord[] {
  return Array.from({ length: count }, (_, i) => ({
    w: `w${i}`,
    s: i * stepMs,
    e: i * stepMs + speechMs,
  }))
}

describe('classifyEnding', () => {
  it('treats . ? ! as sentence ends and , ; : as weak ones', () => {
    expect(classifyEnding('home.')).toBe('strong')
    expect(classifyEnding('home?')).toBe('strong')
    expect(classifyEnding('really!')).toBe('strong')
    expect(classifyEnding('tea,')).toBe('weak')
    expect(classifyEnding('here;')).toBe('weak')
    expect(classifyEnding('this:')).toBe('weak')
    expect(classifyEnding('home')).toBe('none')
  })

  it('judges the period behind a closing quote or bracket', () => {
    expect(classifyEnding('said."')).toBe('strong')
    expect(classifyEnding('home.)')).toBe('strong')
  })

  it('does not split on abbreviations, initials or dotted acronyms', () => {
    // Each of these is the reason a naive /[.?!]$/ test shreds sentences.
    expect(classifyEnding('Mr.')).toBe('none')
    expect(classifyEnding('Dr.')).toBe('none')
    expect(classifyEnding('St.')).toBe('none')
    expect(classifyEnding('etc.')).toBe('none')
    expect(classifyEnding('e.g.')).toBe('none')
    expect(classifyEnding('U.S.')).toBe('none')
    expect(classifyEnding('U.S.A.')).toBe('none')
    expect(classifyEnding('a.m.')).toBe('none')
    expect(classifyEnding('J.')).toBe('none')
  })

  it('does not split on decimals or version numbers', () => {
    // All of these end in a digit, so the period is not the final character
    // and the question does not even arise.
    expect(classifyEnding('3.14')).toBe('none')
    expect(classifyEnding('v2.0')).toBe('none')
    expect(classifyEnding('$1.5')).toBe('none')
  })

  it('splits after a trailing number', () => {
    // Regression: an earlier version treated any "digits." as a numbered-list
    // marker, so "…the streets are after 10." was glued onto the next sentence.
    // No unit test caught it; one end-to-end run against real whisper output did.
    expect(classifyEnding('10.')).toBe('strong')
    expect(classifyEnding('1.')).toBe('strong')
  })

  it('does split on an ellipsis, per the doc', () => {
    expect(classifyEnding('Well...')).toBe('strong')
    expect(classifyEnding('well…')).toBe('strong')
  })

  it('treats a bare punctuation token as a sentence end', () => {
    // whisper.cpp emits "." as its own token; the assembler is expected to
    // attach it, but if one leaks through it must still terminate.
    expect(classifyEnding('.')).toBe('strong')
    expect(classifyEnding(',')).toBe('weak')
  })
})

describe('segmentWords — sentence boundaries', () => {
  it('splits sentences that Whisper glued into one window', () => {
    const { cues } = segmentWords(
      words('I:0-90 moved:150-600 to:650-900 a:950-1100 new:1150-1500 city:1550-1900 .:1950-1950'),
    )
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('I moved to a new city .')
  })

  it('keeps an abbreviation-bearing sentence in one piece', () => {
    const { cues } = segmentWords(
      words(
        'I:0-90 met:150-400 Mr.:450-700 Smith:750-1100 yesterday:1150-1700 .:1750-1750 ' +
          'He:1900-2000 left:2050-2400 .:2450-2450',
      ),
    )
    expect(cues.map((c) => c.text)).toEqual(['I met Mr. Smith yesterday .', 'He left .'])
  })

  it('cuts mid-sentence when a long silence follows', () => {
    const { cues } = segmentWords(
      words('I:0-90 was:150-400 thinking:450-800 about:850-1200 you:1250-1600 ' +
        'and:6000-6200 then:6250-6600 I:6650-6800 left:6850-7200'),
    )
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('I was thinking about you')
    expect(cues[1].text).toBe('and then I left')
  })

  it('only honours weak punctuation when a pause follows it', () => {
    const tight = segmentWords(
      words('I:0-90 like:150-400 tea:450-800 ,:850-850 but:900-1100 coffee:1150-1500 is:1550-1700 better:1750-2100 .:2150-2150'),
    )
    expect(tight.cues).toHaveLength(1)

    // The first clause has to clear rule 4 on its own (>=1s and >=3 words),
    // otherwise rule 4 folds it back and this tests nothing about rule 3.
    const paused = segmentWords(
      words(
        'I:0-90 like:150-400 tea:450-800 a:850-1100 lot:1150-1500 ,:1550-1550 ' +
          'but:2100-2300 coffee:2350-2600 is:2650-2800 better:2850-3200 .:3250-3250',
      ),
    )
    expect(paused.cues.map((c) => c.text)).toEqual([
      'I like tea a lot ,',
      'but coffee is better .',
    ])
  })

  it('lets rule 4 outrank rule 3 for a sub-second clause (ordered rules, as specced)', () => {
    // A comma plus a real pause genuinely cut here, but the resulting clause is
    // 850ms — under minDurMs — so rule 4 folds it straight back. Rules 1-6 are
    // ordered, not ranked; this pins that interaction so it cannot drift.
    const { cues } = segmentWords(
      words('I:0-90 like:150-400 tea:450-800 ,:850-850 but:1400-1600 coffee:1650-2000 is:2050-2200 better:2250-2600 .:2650-2650'),
    )
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('I like tea , but coffee is better .')
  })

  it('derives each cue span from its first and last word', () => {
    const { cues } = segmentWords(
      words('One:100-400 two:450-900 three:950-1400 .:1450-1450 Four:1700-2000 five:2050-2400 six:2450-2800 .:2850-2850'),
    )
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ id: 0, start: 100, end: 1450 })
    expect(cues[1]).toMatchObject({ id: 1, start: 1700, end: 2850 })
  })

  it('carries per-word timings onto the cue', () => {
    const { cues } = segmentWords(words('One:100-400 two:450-900 three:950-1400 .:1450-1450'))
    expect(cues[0].words).toEqual([
      { w: 'One', s: 100, e: 400 },
      { w: 'two', s: 450, e: 900 },
      { w: 'three', s: 950, e: 1400 },
      { w: '.', s: 1450, e: 1450 },
    ])
  })

  it('returns nothing for no words', () => {
    expect(segmentWords([])).toEqual({ cues: [], warnings: [] })
  })
})

describe('segmentWords — fragments and long chunks', () => {
  it('folds a trailing fragment that never terminated into the sentence before it', () => {
    const { cues } = segmentWords(
      words('I:0-90 moved:150-500 here:550-900 last:950-1300 year:1350-1700 .:1750-1750 And:1800-1900'),
    )
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('I moved here last year . And')
  })

  it('folds a leading fragment forward instead of making a one-word cue', () => {
    // "Well ," is a 250ms fragment with nothing behind it to merge into.
    const { cues } = segmentWords(
      words('Well:0-200 ,:250-250 I:1200-1400 think:1450-1700 so:1750-2000 .:2050-2050'),
    )
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ start: 0, end: 2050 })
    expect(cues[0].text).toBe('Well , I think so .')
  })

  it('keeps a short sentence that did terminate (documented deviation from rule 4)', () => {
    const spec = 'Yes:0-300 .:350-350 I:1500-1700 will:1750-2000 .:2050-2050'
    const kept = segmentWords(words(spec))
    expect(kept.cues.map((c) => c.text)).toEqual(['Yes .', 'I will .'])

    const folded = segmentWords(words(spec), { keepShortSentences: false })
    expect(folded.cues.map((c) => c.text)).toEqual(['Yes . I will .'])
  })

  it('splits an over-long chunk even when no single silence is long enough', () => {
    // 40 words of continuous speech, 15.85s total, every gap only 50ms.
    const { cues } = segmentWords(chatter(40))
    expect(cues).toHaveLength(2)
    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(DEFAULT_SEGMENT_OPTIONS.maxDurMs)
    // The cut lands near the middle, not at the first opportunity.
    expect(cues[0].end).toBeGreaterThan(7000)
    expect(cues[0].end).toBeLessThan(9000)
  })

  it('splits recursively until every cue is inside maxDurMs', () => {
    const { cues } = segmentWords(chatter(120))
    expect(cues.length).toBeGreaterThan(2)
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(DEFAULT_SEGMENT_OPTIONS.maxDurMs)
    }
  })

  it('never strands a sliver when it re-cuts a long chunk', () => {
    // A huge pause 400ms before the end must not win over balance.
    const { cues } = segmentWords(chatter(40).map((w, i) => (i === 39 ? { ...w, s: 15_000, e: 15_400 } : w)))
    for (const cue of cues) expect(cue.end - cue.start).toBeGreaterThanOrEqual(400)
  })
})

describe('segmentWords — timings that cannot be trusted', () => {
  it('floors a zero-length cue so the loop has something to seek to', () => {
    const { cues, warnings } = segmentWords(words('Yeah:1000-1000 .:1000-1000'))
    expect(cues[0]).toMatchObject({ start: 1000, end: 1400 })
    expect(warnings.join(' ')).toMatch(/minimum 400ms span/)
  })

  it('trims an overhang rather than letting two cues be active at once', () => {
    // The "." token carries a 600ms span, so cue 1 would run 400ms past the
    // start of cue 2 — two lines highlighted at once, which is the bug that
    // makes the transcript feel broken.
    const { cues, warnings } = segmentWords(
      words(
        'Hello:0-1000 world:1100-3000 .:3200-3800 I:3400-3600 am:3650-3900 here:3950-4200 .:4250-4250',
      ),
    )
    expect(cues).toHaveLength(2)
    expect(cues[0].end).toBe(cues[1].start)
    expect(warnings.join(' ')).toMatch(/Trimmed 1 overlapping cue/)
  })

  it('merges the two cues when trimming would leave nothing to play', () => {
    const { cues, warnings } = segmentWords(
      words('Hello:0-200 .:250-250 I:200-500 am:550-900 .:950-950'),
    )
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello . I am .')
    expect(warnings.join(' ')).toMatch(/Merged 1 cue/)
  })

  it('repairs inverted timestamps and drops empty tokens', () => {
    const { cues, warnings } = segmentWords([
      { w: 'Hello', s: 500, e: 200 },
      { w: '   ', s: 600, e: 700 },
      { w: 'there', s: 800, e: 1200 },
      { w: 'friend', s: 1250, e: 1600 },
      { w: '.', s: 1650, e: 1650 },
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello there friend .')
    expect(warnings.join(' ')).toMatch(/Dropped 1 empty word/)
    expect(warnings.join(' ')).toMatch(/Repaired 1 out-of-order/)
  })

  it('always produces strictly increasing, gap-free cue ids', () => {
    const { cues } = segmentWords(chatter(120))
    expect(cues.map((c) => c.id)).toEqual(cues.map((_, i) => i))
    for (let i = 1; i < cues.length; i += 1) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end)
  })
})

describe('segmentWords — options plumbing', () => {
  it('honours a custom maxDurMs', () => {
    const { cues } = segmentWords(chatter(40), { maxDurMs: 4_000 })
    expect(cues.length).toBeGreaterThan(2)
    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(4_000)
  })

  it('honours a custom gapMs', () => {
    // 500ms of silence between "thinking" and "and"; both clauses clear rule 4.
    const spec = 'I:0-200 was:250-600 thinking:650-1100 and:1600-1800 you:1850-2100 know:2150-2400 .:2450-2450'
    expect(segmentWords(words(spec)).cues).toHaveLength(1)
    expect(segmentWords(words(spec), { gapMs: 300 }).cues).toHaveLength(2)
  })

  it('reports only the three knobs lesson.json persists', () => {
    expect(segmentationRecord(DEFAULT_SEGMENT_OPTIONS)).toEqual({
      maxDurMs: 12_000,
      minDurMs: 1_000,
      gapMs: 700,
    })
  })
})
