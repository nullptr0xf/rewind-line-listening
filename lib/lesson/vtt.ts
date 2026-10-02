import type { Cue } from './schema'

/**
 * Minimal, dependency-free WEBVTT / SRT reader and writer.
 *
 * Scope note: this is deliberately "good enough", not a spec-complete parser.
 * It handles what real subtitle files (and whisper.cpp output) actually contain:
 * CRLF, BOM, `NOTE`/`STYLE` blocks, cue ids, position settings, inline tags and
 * karaoke timestamps. It does NOT handle chapters or multi-region cue styling.
 */

export type TimedLine = {
  startMs: number
  endMs: number
  text: string
}

export type ParseReport = {
  format: 'vtt' | 'srt'
  lines: TimedLine[]
  /** Non-fatal cleanups we had to perform; surfaced in the ingest report. */
  warnings: string[]
}

const TIMESTAMP_ONLY = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/
const CUE_TIMING_SPLIT = /\s*-->\s*/

export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP_ONLY.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1] ?? 0)
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = match[4].padEnd(3, '0').slice(0, 3)
  if (minutes > 59 || seconds > 59) return null
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(fraction)
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&quot;': '"',
  '&#39;': "'",
}

function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ') // inline tags: <i>, <c.colorE5E5E5>, <00:00:01.000>
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strip the lines a cue re-displays from the previous one — YouTube's
 * auto-generated ("rolling") captions.
 *
 * These cues do not advance: each one shows the previous cue's last line(s)
 * above the new text, and each real cue is followed by a ~10ms "echo" cue that
 * shows the previous cue's lines alone. Parsed naively, every spoken line
 * appears two or three times, sliding forward through the transcript — which is
 * exactly what a per-sentence trainer cannot survive, because the duplicates
 * carry no time of their own (they land 10ms apart).
 *
 * The fix is line-level, before joining: drop the longest prefix of the
 * current cue that repeats a suffix of the previous cue *as displayed*. The
 * comparison uses the previous cue's full lines (not the deduped remainder) —
 * the echo cues are the display history, and they are what makes the chain
 * connect. Cues that reduce to nothing (the echoes) are dropped outright.
 *
 * Deliberately exact-match only. A normal subtitle almost never opens with a
 * line identical to its neighbour's last line, so the false-positive rate is
 * negligible; fuzzy matching would risk eating real repetition (song lyrics).
 */
function stripRolledLines(lines: string[], previous: string[]): string[] {
  if (previous.length === 0 || lines.length === 0) return lines
  const max = Math.min(previous.length, lines.length)
  for (let count = max; count > 0; count -= 1) {
    let matched = true
    for (let i = 0; i < count; i += 1) {
      if (lines[i] !== previous[previous.length - count + i]) {
        matched = false
        break
      }
    }
    if (matched) return lines.slice(count)
  }
  return lines
}

export function parseTimedText(input: string): ParseReport {
  const warnings: string[] = []
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  const header = text.trimStart().slice(0, 6)
  const format: 'vtt' | 'srt' = header.toUpperCase().startsWith('WEBVTT') ? 'vtt' : 'srt'

  const lines: TimedLine[] = []
  /** The previous cue's displayed lines — the rolling-caption reference. */
  let previousCueLines: string[] = []
  let rolledAway = 0

  for (const block of text.split(/\n{2,}/)) {
    const blockLines = block
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
    if (blockLines.length === 0) continue

    const first = blockLines[0].trim()
    if (first.toUpperCase().startsWith('WEBVTT')) blockLines.shift()
    if (blockLines.length === 0) continue

    const next = blockLines[0].trim()
    if (/^(NOTE|STYLE|REGION)\b/.test(next)) continue

    const timingIndex = blockLines.findIndex((line) => line.includes('-->'))
    if (timingIndex === -1) continue

    const [rawStart, rawRest] = blockLines[timingIndex].split(CUE_TIMING_SPLIT)
    if (!rawStart || !rawRest) continue
    // Trailing cue settings (position/line/align) are not needed here.
    const rawEnd = rawRest.trim().split(/\s+/)[0]

    const startMs = parseTimestamp(rawStart)
    const endMs = parseTimestamp(rawEnd)
    if (startMs === null || endMs === null) {
      warnings.push(`Skipped a cue with an unparsable timestamp: "${blockLines[timingIndex].trim()}"`)
      continue
    }

    const textLines = blockLines.slice(timingIndex + 1)
      .map((line) => cleanText(line))
      .filter((line) => line.length > 0)
    const kept = stripRolledLines(textLines, previousCueLines)
    previousCueLines = textLines
    if (kept.length === 0) {
      // Either a rolling-caption echo, or a cue whose text was entirely empty.
      // Only the former is worth reporting; an empty cue was silently skipped
      // before rolling support existed.
      if (textLines.length > 0) rolledAway += 1
      continue
    }
    const cueText = kept.join(' ')
    if (!cueText) continue

    if (endMs <= startMs) {
      warnings.push(`Cue has non-positive duration; extended to 1s: "${cueText.slice(0, 40)}"`)
    }

    lines.push({ startMs, endMs: endMs > startMs ? endMs : startMs + 1000, text: cueText })
  }

  lines.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  // Kill overlaps so that exactly one cue can ever be "active". Subtitles from
  // the wild overlap all the time; without this you get two highlighted lines.
  let overlapCount = 0
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = lines[i]
    const upcoming = lines[i + 1]
    if (current.endMs > upcoming.startMs) {
      current.endMs = upcoming.startMs
      overlapCount += 1
    }
  }
  if (overlapCount > 0) {
    warnings.push(`Trimmed ${overlapCount} overlapping cue(s) so only one line can be active at a time.`)
  }
  if (rolledAway > 0) {
    warnings.push(
      `Dropped ${rolledAway} rolling-caption echo cue(s) that only re-displayed the previous line.`,
    )
  }

  return { format, lines, warnings }
}

export function timedLinesToCues(lines: TimedLine[]): Cue[] {
  return lines.map((line, index) => ({
    id: index,
    start: line.startMs,
    end: line.endMs,
    text: line.text,
    words: null,
    translation: null,
    note: '',
    tags: [],
    flags: { edited: false, lowConfidence: false, ignored: false },
  }))
}

export function parseSubtitleText(input: string): { cues: Cue[]; report: ParseReport } {
  const report = parseTimedText(input)
  return { cues: timedLinesToCues(report.lines), report }
}

export function formatTimestamp(ms: number, separator: '.' | ',' = '.'): string {
  const clamped = Math.max(0, Math.round(ms))
  const hours = Math.floor(clamped / 3_600_000)
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`
}

export function formatClock(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const hours = Math.floor(clamped / 3_600_000)
  const minutes = Math.floor((clamped % 3_600_000) / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function cuesToVtt(cues: Cue[]): string {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`,
    )
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}

export function cuesToSrt(cues: Cue[]): string {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(cue.end, ',')}\n${cue.text}`,
    )
    .join('\n\n')
  return `${body}\n`
}
