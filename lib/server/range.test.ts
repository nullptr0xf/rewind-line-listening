import { describe, expect, it } from 'vitest'

import { contentRangeHeader, parseRangeHeader } from './range'

const SIZE = 32_000_000

describe('parseRangeHeader', () => {
  it('treats a missing or empty header as a full response', () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'full' })
  })

  it('ignores headers that are not byte ranges', () => {
    // A <video> element only ever sends bytes=, but proxies have been known to
    // forward junk. Falling back to a full response is always safe.
    expect(parseRangeHeader('items=0-10', SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader('bytes', SIZE)).toEqual({ kind: 'full' })
    expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'full' })
  })

  it('parses an explicit start-end range', () => {
    expect(parseRangeHeader('bytes=0-1023', SIZE)).toEqual({ kind: 'partial', start: 0, end: 1023 })
  })

  it('parses an open-ended range through to the last byte', () => {
    expect(parseRangeHeader('bytes=3400000-', SIZE)).toEqual({
      kind: 'partial',
      start: 3_400_000,
      end: SIZE - 1,
    })
  })

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-2048', SIZE)).toEqual({
      kind: 'partial',
      start: SIZE - 2048,
      end: SIZE - 1,
    })
  })

  it('clamps a suffix range longer than the file to the whole file', () => {
    expect(parseRangeHeader('bytes=-99999999', SIZE)).toEqual({
      kind: 'partial',
      start: 0,
      end: SIZE - 1,
    })
  })

  it('clamps an end offset past the file size', () => {
    expect(parseRangeHeader('bytes=100-99999999', SIZE)).toEqual({
      kind: 'partial',
      start: 100,
      end: SIZE - 1,
    })
  })

  it('rejects ranges that start past the end of the file', () => {
    // Browser behaviour here is to retry; returning 416 is the correct answer.
    expect(parseRangeHeader('bytes=99999999999-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=32000000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('rejects malformed and inverted ranges', () => {
    expect(parseRangeHeader('bytes=abc-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=100-50', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=-abc', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('cannot satisfy any range against an empty file', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('serves the first range of a multi-range request', () => {
    // Video elements do not emit these; multipart/byteranges is not worth
    // implementing, so we deliberately take the first spec.
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toEqual({
      kind: 'partial',
      start: 0,
      end: 99,
    })
  })

  it('tolerates surrounding whitespace and uppercase units', () => {
    expect(parseRangeHeader('  BYTES=0-10  ', SIZE)).toEqual({ kind: 'partial', start: 0, end: 10 })
  })
})

describe('contentRangeHeader', () => {
  it('formats the Content-Range value for a 206 response', () => {
    expect(contentRangeHeader(0, 1023, SIZE)).toBe(`bytes 0-1023/${SIZE}`)
  })
})
