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

    const started = Date.now()
    const run = spawnSync(
      cli,
      ['-m', modelPath, '-f', wavPath, '-l', 'en', '-ojf', '-of', prefix, '-dtw', spec.dtw, '-t', String(THREADS)],
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
    const assembled = assembleWords(json)
    const seg = segmentWords(assembled.words)
    console.log(`  whisper segments ${json.transcription.length} → words ${assembled.words.length} → cues ${seg.cues.length}  (reference ${truth.length})`)
    for (const w of [...assembled.warnings, ...seg.warnings]) console.log(`  ! ${w}`)

    const score = wordErrorRate(refWords, normalize(seg.cues.map((c) => c.text).join(' ')))
    console.log(`  WER ${score.rate.toFixed(2)}%  (${score.errors} edits / ${refWords.length} words)  ${score.rate <= WER_BAR_PERCENT ? 'PASS' : 'OVER THE 5% BAR'}`)

    const starts = seg.cues.map((c) => c.start)
    const errors = truth
      .map((c) => starts.reduce((best, s) => Math.min(best, Math.abs(s - c.start)), Infinity))
      .sort((a, b) => a - b)
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length
    const median = errors[Math.floor(errors.length / 2)]
    console.log(`  cue-start error: mean ${mean.toFixed(0)}ms  median ${median.toFixed(0)}ms  p90 ${errors[Math.floor(errors.length * 0.9)].toFixed(0)}ms`)

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

    outcomes.push({ name, rate: score.rate, cues: seg.cues.length, median })
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
