#!/usr/bin/env node
/**
 * "Why are my timings off?" — a diagnostic for whisper.cpp output.
 *
 * `scripts/bench-asr.ts` answers "is it good enough". This answers "why", by
 * showing the thing that is otherwise invisible: how the two timelines inside a
 * single whisper JSON relate to each other.
 *
 *   node ... scripts/inspect-timeline.ts <whisper.json> [reference.vtt]
 *
 * Everything it prints was expensive to learn. In particular, with `--vad` the
 * token positions are in whisper's speech-only timeline while `offsets` are in
 * the audio, and the gap between them *grows across the file*. Reading a
 * `t_dtw` series that looks obviously wrong is usually this, not a bug in the
 * reader — so the `shift` column is the first thing to check.
 *
 * `--cues` additionally runs the real pipeline (whisper.ts → segment.ts) and
 * scores it against a reference VTT, start and end, signed.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assembleWords, isSpecialToken, parseWhisperJson } from '../lib/lesson/whisper'
import { segmentWords } from '../lib/lesson/segment'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Mirrors whisper.ts: below this the run must have skipped silence, i.e. VAD. */
const VAD_TIMELINE_RATIO = 0.99

const args = process.argv.slice(2)
const scoreCues = args.includes('--cues')
const positional = args.filter((a) => !a.startsWith('--'))
if (positional.length === 0) {
  console.error('usage: inspect-timeline.ts <whisper.json> [reference.vtt] [--cues]')
  process.exit(1)
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)]

function readVtt(file: string): Array<{ start: number; end: number; text: string }> {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      const ti = lines.findIndex((l) => l.includes('-->'))
      if (ti === -1) return null
      const m = /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/.exec(lines[ti])
      if (!m) return null
      const ms = (h: string, mi: string, s: string, f: string) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +f
      return { start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text: lines.slice(ti + 1).join(' ').trim() }
    })
    .filter((c): c is { start: number; end: number; text: string } => c !== null)
}

/** Signed nearest-match error: the sign is what separates bias from noise. */
function score(produced: number[], reference: number[]) {
  const signed = reference.map((r) => {
    const nearest = produced.reduce((best, p) => (Math.abs(p - r) < Math.abs(best - r) ? p : best), Infinity)
    return nearest - r
  })
  const abs = signed.map(Math.abs).sort((a, b) => a - b)
  return { median: abs[Math.floor(abs.length / 2)], p90: abs[Math.floor(abs.length * 0.9)], worst: abs[abs.length - 1], meanSigned: signed.reduce((a, b) => a + b, 0) / signed.length }
}

const jsonPath = path.join(root, positional[0])
const json = parseWhisperJson(fs.readFileSync(jsonPath, 'utf8'))

console.log(`${path.relative(root, jsonPath)}`)
console.log(`${json.transcription.length} segments`)

// --- the two timelines, segment by segment -----------------------------------
console.log()
console.log('  seg  offsets.from  offsets.to    posFirst    posLast    shift   shift(last)   stretch   audio-span  token-span')
console.log('  ' + '-'.repeat(108))

const shifts: number[] = []
const stretches: number[] = []
let audioEnd = 0
let timelineEnd = 0
let shown = 0

for (const seg of json.transcription) {
  audioEnd = Math.max(audioEnd, seg.offsets.to)
  const positions = (seg.tokens ?? [])
    .filter((t) => !isSpecialToken(t.text) && typeof t.t_dtw === 'number')
    .map((t) => t.t_dtw! * 10)
  if (positions.length === 0) continue

  const posFirst = positions[0]
  const posLast = positions[positions.length - 1]
  timelineEnd = Math.max(timelineEnd, posLast)

  const shift = seg.offsets.from - posFirst
  const shiftLast = seg.offsets.to - posLast
  const audioSpan = seg.offsets.to - seg.offsets.from
  const tokenSpan = posLast - posFirst
  shifts.push(shift)
  if (tokenSpan > 0) stretches.push(audioSpan / tokenSpan)

  // A handful of rows is enough to see the trend; the summary below has the rest.
  if (shown < 6 || shown === json.transcription.length - 1) {
    console.log(
      `  ${String(shown).padStart(3)} ${String(seg.offsets.from).padStart(12)} ${String(seg.offsets.to).padStart(12)} ` +
        `${String(posFirst).padStart(11)} ${String(posLast).padStart(11)} ${String(shift).padStart(8)} ${String(shiftLast - shift).padStart(12)} ` +
        `${(tokenSpan > 0 ? (audioSpan / tokenSpan).toFixed(3) : '  —  ').padStart(8)} ${String(audioSpan).padStart(11)} ${String(tokenSpan).padStart(11)}`,
    )
  } else if (shown === 6) {
    console.log('   …')
  }
  shown += 1
}

const coverage = audioEnd > 0 ? timelineEnd / audioEnd : 1
const looksVad = coverage < VAD_TIMELINE_RATIO

console.log()
console.log(`  timeline covers ${(coverage * 100).toFixed(2)}% of the audio  →  ${looksVad ? 'VAD timeline (silence removed)' : 'audio timeline (no VAD)'}`)
console.log(`  shift grows  ${Math.min(...shifts)}ms → ${Math.max(...shifts)}ms  (monotonic growth = silence deleted, so translate per segment)`)
console.log(`  stretch      median ${quantile(stretches, 0.5).toFixed(3)}  (a rescale would distort every gap by this factor)`)

// --- optional: run the real pipeline and score it ----------------------------
if (scoreCues) {
  const refPath = positional[1]
  if (!refPath) {
    console.error('\n--cues needs a reference VTT as the second argument')
    process.exit(1)
  }
  const truth = readVtt(path.join(root, refPath))
  const { words, warnings } = assembleWords(json, { vad: looksVad })
  const { cues } = segmentWords(words)
  const starts = score(cues.map((c) => c.start), truth.map((c) => c.start))
  const ends = score(cues.map((c) => c.end), truth.map((c) => c.end))

  console.log()
  console.log(`  cues ${cues.length} (reference ${truth.length})`)
  for (const w of [...warnings]) console.log(`  ! ${w}`)
  for (const [label, s] of [['start', starts], ['end  ', ends]] as const) {
    console.log(
      `  cue-${label}: median ${s.median.toFixed(0)}ms  p90 ${s.p90.toFixed(0)}ms  worst ${s.worst.toFixed(0)}ms  ` +
        `signed mean ${s.meanSigned >= 0 ? '+' : ''}${s.meanSigned.toFixed(0)}ms`,
    )
  }

  const offsets = new Set(json.transcription.map((s) => s.offsets.from))
  const onBoundary = cues.filter((c) => offsets.has(c.start)).length
  console.log(`  ${onBoundary}/${cues.length} cue starts sit exactly on a segment offset`)
  if (onBoundary === cues.length) {
    console.log('  → cue starts are scoring `offsets.from` alone; on this fixture the token timeline is not exercised')
  }
}
