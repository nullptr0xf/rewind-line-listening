#!/usr/bin/env node
/**
 * ASR + segmentation acceptance harness.
 *
 * M1's acceptance criterion is a measured number — "run 3 different kinds of
 * video through it and check the segmentation line by line, error rate below
 * 5%" — so the measurement is a script rather than a judgement call. It runs the
 * real pipeline modules (`lib/lesson/whisper.ts` → `lib/lesson/segment.ts`) over
 * real whisper output and reports four things:
 *
 *   1. speed, as a real-time multiple
 *   2. WER against a reference transcript, when one is available
 *   3. cue-boundary error against the reference's sentence timings
 *   4. where the produced cue list diverges from the reference
 *
 * (3) is the one that actually matters for a line-synced player: a transcript
 * with correct words and drifting boundaries is unusable.
 *
 * Usage:
 *   npm run bench:asr                                  # the bundled fixture
 *   npm run bench:asr -- --truth subs/ep01.en.vtt --wav ep01.wav
 *   npm run bench:asr -- --media "F:\videos\ep01.mp4"   # wav extracted for you
 *   npm run bench:asr -- --models base.en-q8_0
 *   npm run bench:asr -- --no-vad                       # compare without Silero
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { assembleWords, parseWhisperJson } from '../lib/lesson/whisper'
import { segmentWords } from '../lib/lesson/segment'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(projectRoot, 'tools', 'whisper', 'Release', 'whisper-cli.exe')
const modelsDir = path.join(projectRoot, 'tools', 'whisper', 'models')
const scratchDir = path.join(projectRoot, 'tools', 'whisper', '_bench')

/** Silero VAD weights, staged by `npm run tools:install`. */
const VAD_FILE = 'ggml-silero-v5.1.2.bin'

/** `minBytes` catches a truncated model; the GGML magic alone cannot. */
const MODELS: Record<string, { file: string; dtw: string; minBytes: number }> = {
  'base.en-q8_0': { file: 'ggml-base.en-q8_0.bin', dtw: 'base.en', minBytes: 70e6 },
  'small.en-q5_1': { file: 'ggml-small.en-q5_1.bin', dtw: 'small.en', minBytes: 150e6 },
  'medium.en-q5_0': { file: 'ggml-medium.en-q5_0.bin', dtw: 'medium.en', minBytes: 400e6 },
  'large-v3-turbo-q8_0': { file: 'ggml-large-v3-turbo-q8_0.bin', dtw: 'large.v3.turbo', minBytes: 800e6 },
}

/** Below this, a number is a pass. M1's bar. */
const WER_BAR_PERCENT = 5

/** Recognising is CPU-bound; give whisper-cli every core unless told otherwise. */
const THREADS = Number(process.env.BENCH_THREADS ?? 0) || Math.max(2, os.availableParallelism())

/**
 * Silero VAD is step ④ of the designed pipeline (doc §4.3), so it is on by
 * default. It is worth toggling: it is what trims the leading silence that
 * otherwise lands in the first segment's `offsets` and shifts a whole cue.
 */
const USE_VAD = !process.argv.includes('--no-vad')

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

const truthPath = arg('truth') ?? path.join(projectRoot, 'testmedia', 'listening-fixture-01.vtt')
const mediaPath = arg('media') ?? path.join(projectRoot, 'testmedia', 'listening-fixture-01.mp4')
const wavPath = arg('wav') ?? path.join(scratchDir, '_bench-16k.wav')
const requested = arg('models')?.split(',').map((s) => s.trim()).filter(Boolean) ?? Object.keys(MODELS)

interface TruthCue {
  start: number
  end: number
  text: string
}

function readVtt(file: string): TruthCue[] {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      const timingIndex = lines.findIndex((l) => l.includes('-->'))
      if (timingIndex === -1) return null
      const m = /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/.exec(lines[timingIndex])
      if (!m) return null
      const ms = (h: string, mi: string, s: string, f: string) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +f
      return {
        start: ms(m[1], m[2], m[3], m[4]),
        end: ms(m[5], m[6], m[7], m[8]),
        // The text is everything AFTER the timing line. Slicing from the wrong
        // index turns every timestamp into "reference words" and inflates WER
        // from a truthful 1% to a nonsense 43%.
        text: lines.slice(timingIndex + 1).join(' ').trim(),
      }
    })
    .filter((c): c is TruthCue => c !== null)
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  twenty: '20', thirty: '30', hundred: '100',
}

const normalize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** TTS wrote "10", the recogniser wrote "ten" — same words, not an error. */
const canon = (w: string) => NUMBER_WORDS[w] ?? w

function wordErrorRate(ref: string[], hyp: string[]) {
  const r = ref.map(canon)
  const h = hyp.map(canon)
  const d: number[][] = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0))
  for (let i = 0; i <= r.length; i++) d[i][0] = i
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))

  const ops: string[] = []
  let i = r.length
  let j = h.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && r[i - 1] === h[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      ops.push(r[i - 1]); i--; j--
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      ops.push(`[${r[i - 1]}→${h[j - 1]}]`); i--; j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push(`(-${r[i - 1]})`); i--
    } else {
      ops.push(`(+${h[j - 1]})`); j--
    }
  }
  ops.reverse()

  const notable: string[] = []
  for (let k = 0; k < ops.length && notable.length < 20; k++) {
    if (!/^[[(]/.test(ops[k])) continue
    notable.push('    … ' + ops.slice(Math.max(0, k - 7), k + 7).join(' '))
  }
  return { errors: d[r.length][h.length], rate: (d[r.length][h.length] / r.length) * 100, notable }
}

const clock = (t: number) =>
  `${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.${String(Math.round(t % 1000)).padStart(3, '0')}`

/**
 * Nearest-match boundary error, kept *signed*.
 *
 * The sign is the whole point: a noisy-but-honest ±100ms and a systematic
 * −550ms bias produce the same median of absolute values but need different
 * responses — the first is a limitation, the second is a bug or the wrong model.
 * Nearest-match (rather than index-paired) keeps one merged cue from reporting
 * as a 15-second outlier.
 */
function boundaryError(produced: number[], reference: number[]) {
  const signed = reference.map((r) => {
    const nearest = produced.reduce((best, p) => (Math.abs(p - r) < Math.abs(best - r) ? p : best), Infinity)
    return nearest - r
  })
  const abs = signed.map(Math.abs).sort((a, b) => a - b)
  return {
    signed,
    median: abs[Math.floor(abs.length / 2)],
    p90: abs[Math.floor(abs.length * 0.9)],
    worst: abs[abs.length - 1],
    meanSigned: signed.reduce((a, b) => a + b, 0) / signed.length,
  }
}

function ensureWav(): void {
  if (fs.existsSync(wavPath)) return
  fs.mkdirSync(path.dirname(wavPath), { recursive: true })
  // whisper-cli does not read containers; 16 kHz mono is what it wants anyway,
  // and it is the same extraction the real pipeline performs.
  const run = spawnSync(
    path.join(projectRoot, 'tools', 'ffmpeg.exe'),
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', mediaPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr || run.stdout}`)
}

function main(): void {
  const truth = readVtt(truthPath)
  const refWords = normalize(truth.map((c) => c.text).join(' '))
  const audioSeconds = Number(
    spawnSync(path.join(projectRoot, 'tools', 'ffprobe.exe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath,
    ], { encoding: 'utf8' }).stdout.trim(),
  )
  console.log(`reference: ${truth.length} cues, ${refWords.length} words  (${path.relative(projectRoot, truthPath)})`)
  console.log(`audio:     ${audioSeconds.toFixed(1)}s\n`)

  ensureWav()
  fs.mkdirSync(scratchDir, { recursive: true })

  const outcomes: Array<{ name: string; rate: number; cues: number; median: number }> = []

  for (const name of requested) {
    const spec = MODELS[name]
    if (!spec) {
      console.error(`unknown model "${name}"`)
      process.exitCode = 1
      continue
    }
    const modelPath = path.join(modelsDir, spec.file)
    console.log('='.repeat(74))
    console.log(name)
    console.log('='.repeat(74))

    const size = fs.existsSync(modelPath) ? fs.statSync(modelPath).size : 0
    const magic = size ? fs.readFileSync(modelPath).subarray(0, 4).toString('latin1') : ''
    if (magic !== 'lmgg' || size < spec.minBytes) {
      console.log(
        `  unusable (magic=${JSON.stringify(magic)}, ${(size / 1e6).toFixed(0)}/${(spec.minBytes / 1e6).toFixed(0)} MB)` +
          ` — run: npm run tools:install -- --model ${name}\n`,
      )
      continue
    }

    const prefix = path.join(scratchDir, name)
    for (const f of fs.readdirSync(scratchDir)) {
      if (f.startsWith(name)) fs.unlinkSync(path.join(scratchDir, f))
    }

    const vadPath = path.join(modelsDir, VAD_FILE)
    const vadArgs = USE_VAD && fs.existsSync(vadPath) ? ['--vad', '-vm', vadPath] : []
    if (USE_VAD && vadArgs.length === 0) {
      console.log(`  ! Silero weights missing (${VAD_FILE}) — running without VAD; npm run tools:install stages them`)
    }

    const started = Date.now()
    const run = spawnSync(
      cli,
      ['-m', modelPath, '-f', wavPath, '-l', 'en', ...vadArgs, '-ojf', '-of', prefix, '-dtw', spec.dtw, '-t', String(THREADS)],
      { encoding: 'utf8', timeout: 3_600_000, maxBuffer: 256 * 1024 * 1024 },
    )
    const elapsed = (Date.now() - started) / 1000
    if (run.status !== 0) {
      console.log(`  whisper-cli failed: ${(run.stderr || run.stdout).slice(-1200)}\n`)
      process.exitCode = 1
      continue
    }
    console.log(`  ${elapsed.toFixed(1)}s → ${(audioSeconds / elapsed).toFixed(2)}× real time`)

    const json = parseWhisperJson(fs.readFileSync(`${prefix}.json`, 'utf8'))
    // Must mirror what whisper-cli was actually given: with --vad the token
    // timings are in whisper's speech-only timeline and have to be rescaled.
    const assembled = assembleWords(json, { vad: vadArgs.length > 0 })
    const seg = segmentWords(assembled.words)
    console.log(`  whisper segments ${json.transcription.length} → words ${assembled.words.length} → cues ${seg.cues.length}  (reference ${truth.length})`)
    for (const w of [...assembled.warnings, ...seg.warnings]) console.log(`  ! ${w}`)

    const score = wordErrorRate(refWords, normalize(seg.cues.map((c) => c.text).join(' ')))
    console.log(`  WER ${score.rate.toFixed(2)}%  (${score.errors} edits / ${refWords.length} words)  ${score.rate <= WER_BAR_PERCENT ? 'PASS' : 'OVER THE 5% BAR'}`)

    const starts = boundaryError(seg.cues.map((c) => c.start), truth.map((c) => c.start))
    const ends = boundaryError(seg.cues.map((c) => c.end), truth.map((c) => c.end))
    const show = (label: string, s: ReturnType<typeof boundaryError>) =>
      console.log(
        `  ${label}: median ${s.median.toFixed(0)}ms  p90 ${s.p90.toFixed(0)}ms  worst ${s.worst.toFixed(0)}ms  ` +
          `signed mean ${s.meanSigned >= 0 ? '+' : ''}${s.meanSigned.toFixed(0)}ms`,
      )
    show('cue-start', starts)
    show('cue-end  ', ends)

    // A negative cue-end bias is expected and is not drift: the reference keeps
    // its cues contiguous (each ends exactly where the next begins), whereas we
    // end a cue at the last word's real acoustic end. The difference is the
    // inter-line pause. Say so, or the number reads as a defect forever.
    const touching = truth.filter((c, i) => i + 1 < truth.length && Math.abs(c.end - truth[i + 1].start) < 120).length
    if (touching > (truth.length - 1) * 0.8) {
      console.log(
        `  (reference cues are contiguous — ${touching}/${truth.length - 1} of its ends touch the next start — ` +
          'so a negative cue-end bias of about one pause is a convention difference, not drift)',
      )
    }

    // Sensitivity check. When --vad is on, whisper splits exactly where the
    // silences are, so on a well-cut fixture every cue can land on a segment
    // boundary — and then the cue-start number is scoring `offsets.from` alone
    // while the whole token timeline goes unmeasured. Say so rather than let a
    // good number read as validation.
    const offsets = new Set(json.transcription.map((s) => s.offsets.from))
    const onBoundary = seg.cues.filter((c) => offsets.has(c.start)).length
    console.log(
      `  ${onBoundary}/${seg.cues.length} cue starts sit exactly on a whisper segment offset` +
        (onBoundary === seg.cues.length ? ' — this fixture can only score the offset, not the token timeline' : ''),
    )

    console.log('  first 6 cues:')
    for (const cue of seg.cues.slice(0, 6)) console.log(`    [${clock(cue.start)} → ${clock(cue.end)}] ${cue.text}`)

    // A count difference is only meaningful if you see which lines differ.
    console.log('  divergence from the reference:')
    let last = -1
    let divergences = 0
    for (const cue of seg.cues) {
      let bestIndex = 0
      let bestDistance = Infinity
      for (const [i, t] of truth.entries()) {
        const distance = Math.abs(t.start - cue.start)
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
        }
      }
      if (bestIndex === last) {
        console.log(`    extra:  [${clock(cue.start)}] ${cue.text}`)
        divergences += 1
      } else if (bestIndex > last + 1) {
        console.log(`    missing: reference #${last + 2}..${bestIndex} has no matching cue`)
        divergences += 1
      }
      last = bestIndex
    }
    if (divergences === 0) console.log('    none')

    console.log('  text edits in context:')
    console.log(score.notable.length ? score.notable.join('\n') : '    none')
    console.log()

    outcomes.push({ name, rate: score.rate, cues: seg.cues.length, median: starts.median })
  }

  if (outcomes.length > 1) {
    console.log('summary')
    console.log('  model                 WER     cues   median boundary error')
    for (const o of outcomes) {
      console.log(`  ${o.name.padEnd(22)} ${o.rate.toFixed(2).padStart(5)}% ${String(o.cues).padStart(6)} ${String(o.median).padStart(9)}ms`)
    }
  }
}

main()
