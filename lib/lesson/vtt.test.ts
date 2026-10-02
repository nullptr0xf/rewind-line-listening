import { describe, expect, it } from 'vitest'

import {
  cuesToSrt,
  cuesToVtt,
  formatClock,
  formatTimestamp,
  parseSubtitleText,
  parseTimedText,
  parseTimestamp,
  resegmentCues,
} from './vtt'

describe('parseTimestamp', () => {
  it('parses the WEBVTT form (dot separator, mandatory hours)', () => {
    expect(parseTimestamp('00:00:01.000')).toBe(1000)
    expect(parseTimestamp('01:02:03.456')).toBe(3_723_456)
  })

  it('parses the SRT form (comma separator)', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1500)
  })

  it('accepts a missing hours field', () => {
    expect(parseTimestamp('2:03.5')).toBe(123_500)
  })

  it('pads a short fraction to milliseconds', () => {
    // ".5" means 500ms, not 5ms — getting this wrong shifts every cue.
    expect(parseTimestamp('00:00:01.5')).toBe(1500)
    expect(parseTimestamp('00:00:01.05')).toBe(1050)
  })

  it('rejects invalid minute and second fields', () => {
    expect(parseTimestamp('00:75:00.000')).toBeNull()
    expect(parseTimestamp('00:00:75.000')).toBeNull()
  })

  it('rejects anything that is not a bare timestamp', () => {
    expect(parseTimestamp('not-a-time')).toBeNull()
    expect(parseTimestamp('00:00:01.000 align:start')).toBeNull()
  })
})

describe('parseTimedText — format detection', () => {
  it('recognises WEBVTT even behind a BOM and CRLF line endings', () => {
    const vtt = '\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n'
    const report = parseTimedText(vtt)
    expect(report.format).toBe('vtt')
    expect(report.lines).toHaveLength(1)
    expect(report.lines[0]).toMatchObject({ startMs: 1000, endMs: 2000, text: 'Hello' })
  })

  it('falls back to SRT for a file with no header', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'
    expect(parseTimedText(srt).format).toBe('srt')
  })

  it('returns no lines for an empty file', () => {
    const report = parseTimedText('')
    expect(report.lines).toEqual([])
    expect(report.warnings).toEqual([])
  })
})

describe('parseTimedText — real-world subtitle junk', () => {
  it('skips NOTE / STYLE / REGION blocks', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this is a comment',
      'spanning two lines',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Actual line',
    ].join('\n')

    const report = parseTimedText(vtt)
    expect(report.lines).toHaveLength(1)
    expect(report.lines[0].text).toBe('Actual line')
  })

  it('handles a cue identifier line before the timing line', () => {
    const vtt = ['WEBVTT', '', 'cue-1', '00:00:01.000 --> 00:00:02.000', 'Identified'].join('\n')
    expect(parseTimedText(vtt).lines[0].text).toBe('Identified')
  })

  it('strips inline styling tags and karaoke timestamps', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '<c.colorE5E5E5>Hello</c> <i>there</i> <00:00:01.500>world',
    ].join('\n')

    // A tag must not leave a hole behind, hence the single space it collapses to.
    expect(parseTimedText(vtt).lines[0].text).toBe('Hello there world')
  })

  it('decodes HTML entities and drops unknown ones', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Tom &amp; Jerry &lt;3 &unknown; yes',
    ].join('\n')

    expect(parseTimedText(vtt).lines[0].text).toBe('Tom & Jerry <3 yes')
  })

  it('joins multi-line cue text into a single line', () => {
    const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', 'First half', 'second half'].join(
      '\n',
    )
    expect(parseTimedText(vtt).lines[0].text).toBe('First half second half')
  })

  it('ignores trailing cue settings such as position and align', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000 align:start position:10%',
      'Positioned',
    ].join('\n')

    const report = parseTimedText(vtt)
    expect(report.lines[0]).toMatchObject({ startMs: 1000, endMs: 2000, text: 'Positioned' })
  })

  it('warns about an unparsable timestamp instead of silently dropping the cue', () => {
    const vtt = ['WEBVTT', '', '1', 'not-a-time --> 00:00:05.000', 'Orphan'].join('\n')
    const report = parseTimedText(vtt)
    expect(report.lines).toEqual([])
    expect(report.warnings.join()).toMatch(/unparsable timestamp/)
  })

  it('gives a zero-length cue 1s of life and warns about it', () => {
    const vtt = ['WEBVTT', '', '00:00:05.000 --> 00:00:05.000', 'Instant'].join('\n')
    const report = parseTimedText(vtt)
    expect(report.lines[0]).toMatchObject({ startMs: 5000, endMs: 6000 })
    expect(report.warnings.join()).toMatch(/non-positive duration/)
  })

  it('skips cues whose text is empty', () => {
    const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', '   '].join('\n')
    expect(parseTimedText(vtt).lines).toEqual([])
  })
})

describe('parseTimedText — ordering and overlap', () => {
  it('sorts out-of-order cues by start time', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:05.000 --> 00:00:06.000',
      'Second',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'First',
    ].join('\n')

    expect(parseTimedText(vtt).lines.map((line) => line.text)).toEqual(['First', 'Second'])
  })

  it('trims overlapping cues so only one line can ever be active', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.500',
      'First',
      '',
      '00:00:03.400 --> 00:00:05.000',
      'Second',
    ].join('\n')

    const report = parseTimedText(vtt)
    // Without this trim, 3.4s-3.5s would highlight two lines at once.
    expect(report.lines[0].endMs).toBe(3400)
    expect(report.lines[1].startMs).toBe(3400)
    expect(report.warnings.join()).toMatch(/overlapping cue/)
  })

  it('produces a transcript where findActiveCue would highlight exactly one line', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'One',
      '',
      '2',
      '00:00:02,500 --> 00:00:04,000',
      'Two',
    ].join('\n')

    const { cues } = parseSubtitleText(srt)
    for (const cue of cues) {
      const overlapping = cues.filter((other) => other.start < cue.end && cue.start < other.end)
      expect(overlapping).toHaveLength(1)
    }
  })
})

describe('parseTimedText — YouTube rolling captions', () => {
  // The shape youtube-dl writes for auto-generated captions: each cue shows the
  // previous cue's last line above the new text, and each real cue is followed
  // by a ~10ms echo cue that re-displays the previous lines alone.
  const rolling = [
    'WEBVTT',
    '',
    '00:00:00.080 --> 00:00:02.550 align:start position:0%',
    'A lot has been going on with AI over the',
    '',
    '00:00:02.550 --> 00:00:02.560 align:start position:0%',
    'A lot has been going on with AI over the',
    '',
    '00:00:02.560 --> 00:00:04.470 align:start position:0%',
    'A lot has been going on with AI over the',
    'past few years. Prompt engineering,',
    '',
    '00:00:04.470 --> 00:00:04.480 align:start position:0%',
    'past few years. Prompt engineering,',
    '',
  ].join('\n')

  it('keeps each spoken line exactly once instead of two or three times', () => {
    const report = parseTimedText(rolling)
    expect(report.lines.map((line) => line.text)).toEqual([
      'A lot has been going on with AI over the',
      'past few years. Prompt engineering,',
    ])
  })

  it('drops the 10ms echo cues outright and says so', () => {
    const report = parseTimedText(rolling)
    expect(report.lines.some((line) => line.endMs - line.startMs <= 20)).toBe(false)
    expect(report.warnings.join()).toMatch(/rolling-caption echo/)
  })

  it('strips karaoke-tagged rolling lines by comparing cleaned text', () => {
    // Real files carry word timings as <c> tags inside the line — the roll
    // comparison has to happen after tags are stripped, not before.
    const tagged = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'A<00:00:00.400><c> lot</c> has been going on',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'A lot has been going on',
      'with<00:00:02.200><c> AI</c> lately',
      '',
    ].join('\n')

    expect(parseTimedText(tagged).lines.map((line) => line.text)).toEqual([
      'A lot has been going on',
      'with AI lately',
    ])
  })

  it('leaves a normal subtitle untouched even when a line genuinely repeats', () => {
    // Repeated chorus — exact-match stripping must still eat it, but the cue
    // itself (with its own new second line) must survive.
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Yeah yeah yeah',
      '',
      '00:00:03.000 --> 00:00:04.000',
      'Yeah yeah yeah',
      'here we go again',
      '',
    ].join('\n')

    expect(parseTimedText(vtt).lines.map((line) => line.text)).toEqual([
      'Yeah yeah yeah',
      'here we go again',
    ])
  })
})

describe('timing helpers', () => {
  it('formats a WEBVTT timestamp with a dot', () => {
    expect(formatTimestamp(3_723_456)).toBe('01:02:03.456')
  })

  it('formats an SRT timestamp with a comma', () => {
    expect(formatTimestamp(3_723_456, ',')).toBe('01:02:03,456')
  })

  it('clamps negative values instead of emitting a negative clock', () => {
    expect(formatTimestamp(-500)).toBe('00:00:00.000')
  })

  it('drops the hours field from the UI clock when under an hour', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(83_000)).toBe('01:23')
    expect(formatClock(3_723_456)).toBe('1:02:03')
  })
})

describe('round trip', () => {
  // The serializer round-trips *cues*, so these opt out of sentence
  // re-segmentation — a re-cut transcript would not compare line for line.
  it('survives cues -> WEBVTT -> cues', () => {
    const original = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.500',
      'First line',
      '',
      '00:00:03.000 --> 00:00:04.250',
      'Second line',
    ].join('\n')

    const { cues } = parseSubtitleText(original, { resegment: false })
    const reparsed = parseSubtitleText(cuesToVtt(cues), { resegment: false }).cues

    expect(reparsed.map((cue) => [cue.start, cue.end, cue.text])).toEqual(
      cues.map((cue) => [cue.start, cue.end, cue.text]),
    )
  })

  it('survives cues -> SRT -> cues', () => {
    const { cues } = parseSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nOnly line', {
      resegment: false,
    })
    const reparsed = parseSubtitleText(cuesToSrt(cues), { resegment: false })
    expect(reparsed.report.format).toBe('srt')
    expect(reparsed.cues.map((cue) => [cue.start, cue.end, cue.text])).toEqual(
      cues.map((cue) => [cue.start, cue.end, cue.text]),
    )
  })

  it('numbers cues sequentially starting at 1', () => {
    const { cues } = parseSubtitleText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText', {
      resegment: false,
    })
    expect(cuesToVtt(cues)).toMatch(/^WEBVTT\n\n1\n/)
  })
})

describe('resegmentCues — sidecar lines become sentences', () => {
  // Real shape from the AI-Agents lecture: YouTube's own captions, cut every
  // ~2 seconds at display width, after rolling dedup.
  const displayCut = [
    'WEBVTT',
    '',
    '00:00:00.080 --> 00:00:02.550',
    'A lot has been going on with AI over the',
    '',
    '00:00:02.560 --> 00:00:04.470',
    'past few years. Prompt engineering,',
    '',
    '00:00:04.480 --> 00:00:06.789',
    'context, windows, tokens, embeddings,',
    '',
    '00:00:06.799 --> 00:00:09.990',
    'rag, vector DB, MCPS, agents, lang',
    '',
    '00:00:10.000 --> 00:00:12.470',
    'chain, langraph, claude, Gemini, and',
    '',
    '00:00:12.480 --> 00:00:14.549',
    'more. If you felt left out, this is the',
    '',
    '00:00:14.559 --> 00:00:16.470',
    'only video you will need to watch.',
    '',
  ].join('\n')

  it('merges display lines into sentence cues at the punctuation', () => {
    const { cues } = parseSubtitleText(displayCut)
    expect(cues.map((cue) => cue.text)).toEqual([
      'A lot has been going on with AI over the past few years.',
      'Prompt engineering, context, windows, tokens, embeddings, rag, vector DB, MCPS, agents, lang chain, langraph, claude, Gemini, and more.',
      'If you felt left out, this is the only video you will need to watch.',
    ])
  })

  it('keeps sentence cues inside the time they were actually spoken', () => {
    const { cues } = parseSubtitleText(displayCut)
    for (const cue of cues) {
      expect(cue.start).toBeGreaterThanOrEqual(80)
      expect(cue.end).toBeLessThanOrEqual(16_470)
      expect(cue.end).toBeGreaterThan(cue.start)
    }
    // The first sentence ends where "years." was interpolated inside its
    // display line (2560-4470) — a word-level boundary, not the line's edge.
    expect(cues[0].end).toBeGreaterThan(2560)
    expect(cues[0].end).toBeLessThan(4470)
  })

  it('reports the re-split in the ingest report', () => {
    const { report } = parseSubtitleText(displayCut)
    expect(report.warnings.join()).toMatch(/Re-split 7 caption line\(s\) into 3 sentence cue\(s\)/)
  })

  it('is idempotent on its own output', () => {
    const first = parseSubtitleText(displayCut).cues
    const second = resegmentCues(first)
    expect(second.map((cue) => [cue.start, cue.end, cue.text])).toEqual(
      first.map((cue) => [cue.start, cue.end, cue.text]),
    )
  })

  it('resegment: false keeps the file cue-for-cue', () => {
    const { cues } = parseSubtitleText(displayCut, { resegment: false })
    expect(cues).toHaveLength(7)
    expect(cues[0].text).toBe('A lot has been going on with AI over the')
  })

  it('preserves a real gap between cues as a sentence boundary', () => {
    const gapped = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Chapter one ends here',
      '',
      '00:00:08.000 --> 00:00:09.000',
      'Chapter two begins',
      '',
    ].join('\n')

    const { cues } = parseSubtitleText(gapped)
    expect(cues.map((cue) => cue.text)).toEqual(['Chapter one ends here', 'Chapter two begins'])
    expect(cues[1].start).toBe(8000)
  })
})
