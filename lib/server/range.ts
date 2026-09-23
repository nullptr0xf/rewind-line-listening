/**
 * HTTP Range parsing for the media streaming route.
 *
 * Drag-to-seek in a <video> element is implemented by the browser as a new
 * Range request. Getting this wrong is instantly visible: the scrubber refuses
 * to move, or seeking jumps to the start. Kept as a pure function so it can be
 * unit tested without spinning up a server.
 */

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): RangeResult {
  if (!header) return { kind: 'full' }

  const match = /^bytes=(.+)$/i.exec(header.trim())
  if (!match) return { kind: 'full' }

  // Multi-range requests exist but video elements do not use them; serve the
  // first range rather than guessing at multipart/byteranges.
  const spec = match[1].split(',')[0]?.trim()
  if (!spec) return { kind: 'full' }

  const [rawStart, rawEnd] = spec.split('-')
  if (rawStart === undefined || rawEnd === undefined) return { kind: 'full' }

  if (size <= 0) return { kind: 'unsatisfiable' }

  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isInteger(start) || start < 0) return { kind: 'unsatisfiable' }
  if (start >= size) return { kind: 'unsatisfiable' }

  if (rawEnd === '') return { kind: 'partial', start, end: size - 1 }

  const end = Number(rawEnd)
  if (!Number.isInteger(end) || end < start) return { kind: 'unsatisfiable' }

  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`
}
