/**
 * Generates the M0 test fixture: an English talking-head replacement, with a
 * matching subtitle file whose timings are exact by construction.
 *
 * Why synthesise instead of downloading an open movie?
 *   1. This machine cannot reach the usual download mirrors, and
 *   2. it turns out to be strictly better for this purpose anyway.
 *
 * Every sentence is rendered separately, so its duration is known to the
 * millisecond from the WAV header, and the subtitle is built from the same
 * numbers the audio was built from. That makes the fixture a *measurable*
 * reference: if the highlighted line and the spoken sentence disagree, it is a
 * bug in the player, not ambiguity in the source material.
 *
 * Output (testmedia/):
 *   listening-fixture-01.mp4   video + audio, deliberately 1-second keyframes
 *   listening-fixture-01.vtt   sidecar subtitle, auto-discovered on import
 *   listening-fixture-01.wav   the concatenated speech track (kept for reference)
 *
 * The video is only a burnt-in frame counter, on purpose: you can see the
 * timestamp the player thinks it is at, which makes seek behaviour obvious.
 *
 * Usage:  npm run fixture -- [--sentences 20] [--name listening-fixture-01]
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ESpeakNg from 'espeak-ng'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testmediaDir = path.join(projectRoot, 'testmedia')
const ffmpegPath = path.join(projectRoot, 'tools', 'ffmpeg.exe')

/** A short monologue about learning to listen — reads like real material. */
const SCRIPT = [
  'I moved to a new city last autumn, and I still get lost on the way home.',
  'The first thing I noticed was how quiet the streets are after ten.',
  'Back home, there was always someone talking, somewhere, at any hour.',
  'Here, the evenings belong to the dogs and the delivery bikes.',
  'I started keeping a notebook of the phrases I kept hearing.',
  'Small talk, mostly: the weather, the traffic, whether the bus was late again.',
  'It turns out people say the same twelve things over and over.',
  'If you can catch those twelve, you can survive almost any conversation.',
  'The hard part is not the words, it is the speed they arrive at.',
  'A sentence I could read in three seconds goes by in one.',
  'So I began to slow the recordings down and listen to the same line twice.',
  'That changed everything, honestly.',
  'You start to hear the ending of a word, which you never hear at full speed.',
  'You hear where one thought stops and the next one starts.',
  'After a few weeks, my ear stopped panicking.',
  'I still miss words, but now I miss them and keep going.',
  'That is the whole trick, as far as I can tell.',
  'Do not stop at the gap; let the sentence finish, and then go back.',
  'Anyway, the coffee here is better than I expected.',
  'I will keep practising until the news feels like a conversation.',
]

const LEAD_IN_MS = 1200
const GAP_MS = 700
const TAIL_MS = 1400

function parseArgs(argv) {
  const options = { sentences: SCRIPT.length, name: 'listening-fixture-01', speechRate: 150 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--sentences') options.sentences = Number(argv[++index]) || SCRIPT.length
    else if (token === '--name') options.name = argv[++index] ?? options.name
    else if (token === '--rate') options.speechRate = Number(argv[++index]) || options.speechRate
  }
  return options
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer')
  }

  let offset = 12
  let format = null
  let data = null

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, offset + 8 + size)

    if (id === 'fmt ' && body.length >= 16) {
      format = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        byteRate: body.readUInt32LE(8),
        bitsPerSample: body.readUInt16LE(14),
      }
    } else if (id === 'data') {
      data = Buffer.from(body)
    }

    offset += 8 + size + (size % 2)
  }

  if (!format || !data) throw new Error('WAV is missing a fmt or data chunk')
  return { format, data }
}

function buildWavBuffer(format, pcm) {
  const header = Buffer.alloc(44)
  const byteRate = format.sampleRate * format.channels * (format.bitsPerSample / 8)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(format.channels, 22)
  header.writeUInt32LE(format.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(format.channels * (format.bitsPerSample / 8), 32)
  header.writeUInt16LE(format.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

function silenceBytes(format, milliseconds) {
  const byteRate = format.sampleRate * format.channels * (format.bitsPerSample / 8)
  return Buffer.alloc(Math.round((byteRate * milliseconds) / 1000))
}

function formatTimestamp(ms) {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

async function synthesise(text, speechRate) {
  const espeak = await ESpeakNg({
    arguments: ['-w', 'line.wav', '-v', 'en-us', '-s', String(speechRate), '-p', '45', text],
  })
  const bytes = espeak.FS.readFile('line.wav')
  return parseWav(Buffer.from(bytes))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sentences = SCRIPT.slice(0, options.sentences)

  if (!fs.existsSync(ffmpegPath)) {
    console.error(`ffmpeg not found at ${ffmpegPath}\nRun: npm run tools:install`)
    process.exitCode = 1
    return
  }

  fs.mkdirSync(testmediaDir, { recursive: true })

  console.log(`Synthesising ${sentences.length} sentence(s) with eSpeak NG (en-us, ${options.speechRate} wpm)…`)

  const rendered = []
  let format = null

  for (const [index, text] of sentences.entries()) {
    const { format: lineFormat, data } = await synthesise(text, options.speechRate)
    if (!format) format = lineFormat
    else if (
      lineFormat.sampleRate !== format.sampleRate ||
      lineFormat.channels !== format.channels ||
      lineFormat.bitsPerSample !== format.bitsPerSample
    ) {
      throw new Error('eSpeak produced inconsistent sample formats between lines')
    }

    const durationMs = (data.length / lineFormat.byteRate) * 1000
    rendered.push({ text, data, durationMs })
    process.stdout.write(`  ${String(index + 1).padStart(3)}  ${durationMs.toFixed(0).padStart(5)} ms  ${text}\n`)
  }

  // Lay the lines out on a timeline and emit both the audio and the subtitle
  // from the very same numbers.
  const chunks = [silenceBytes(format, LEAD_IN_MS)]
  const cues = []
  let cursorMs = LEAD_IN_MS

  for (const line of rendered) {
    cues.push({ startMs: cursorMs, endMs: cursorMs + line.durationMs, text: line.text })
    chunks.push(line.data)
    chunks.push(silenceBytes(format, GAP_MS))
    cursorMs += line.durationMs + GAP_MS
  }

  const totalMs = cursorMs + TAIL_MS
  chunks.push(silenceBytes(format, TAIL_MS))

  const pcm = Buffer.concat(chunks)
  const wavPath = path.join(testmediaDir, `${options.name}.wav`)
  fs.writeFileSync(wavPath, buildWavBuffer(format, pcm))

  const vtt = [
    'WEBVTT',
    '',
    ...cues.map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`,
    ),
  ].join('\n')
  const vttPath = path.join(testmediaDir, `${options.name}.vtt`)
  fs.writeFileSync(vttPath, vtt, 'utf8')

  const mp4Path = path.join(testmediaDir, `${options.name}.mp4`)
  const durationSeconds = (totalMs / 1000).toFixed(3)

  console.log(`\nMuxing ${durationSeconds}s of video (1-second keyframes)…`)

  // `testsrc` burns a running frame counter into the picture, so the position
  // the player believes it is at is visible on screen. The keyframe interval is
  // forced to exactly one second, matching the "practice proxy" recommendation
  // in the design doc — which makes this file a fair test for seek latency.
  const result = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc=size=1280x720:rate=25',
      '-i', wavPath,
      '-t', durationSeconds,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-g', '25',
      '-keyint_min', '25',
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '1',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-shortest',
      mp4Path,
    ],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    console.error('ffmpeg failed:')
    console.error(result.stderr || result.stdout)
    process.exitCode = 1
    return
  }

  fs.rmSync(wavPath, { force: true })

  console.log(`\nFixture ready:`)
  console.log(`  ${mp4Path}`)
  console.log(`  ${vttPath}  (sidecar — picked up automatically on import)`)
  console.log(`\nTotal length: ${durationSeconds}s, ${cues.length} lines.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
