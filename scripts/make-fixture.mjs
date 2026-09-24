/**
 * Generates the test fixture for M0: English speech with a sidecar subtitle
 * whose timings are exact by construction.
 *
 * Why synthesise instead of downloading an open movie?
 *   1. The usual download mirrors are unreachable from here, and
 *   2. it turns out to be strictly better for this purpose anyway.
 *
 * The whole passage is synthesised in ONE request, so the prosody flows the way
 * speech actually flows — no stitching, no artificial gaps between lines. The
 * engine then hands back a word-boundary timeline (offset + duration for every
 * spoken word), and the subtitle is built by grouping those words back into the
 * sentences they came from.
 *
 * That makes the fixture a *measurable* reference rather than a plausible one:
 * if the highlighted line and the spoken sentence disagree, it is a bug in the
 * player, not ambiguity in the source material.
 *
 * Two backends:
 *   edge   (default)  Microsoft Edge's read-aloud neural voices. Natural
 *                     prosody, word boundaries for free. Needs the network.
 *   espeak            eSpeak NG compiled to WebAssembly, entirely offline.
 *                     Clearly robotic — fine for judging sync, useless for
 *                     judging whether listening is pleasant.
 *
 * Output (testmedia/):
 *   <name>.mp4   video + audio, deliberately 1-second keyframes
 *   <name>.vtt   sidecar subtitle, auto-discovered on import
 *
 * The picture is deliberate and it is not decoration: a soft "ruled paper"
 * background with the **actual audio** drawn across it as a scrolling waveform.
 * That makes the frame informative in exactly the way a listening trainer needs
 * — you can see speech begin and end, see the pauses between sentences, and
 * confirm that seeking landed where you meant. The old `testsrc` pattern read as
 * "no signal", which is the one thing a picture must never say here.
 *
 * Usage:
 *   npm run fixture
 *   npm run fixture -- --sentences 8
 *   npm run fixture -- --voice en-GB-RyanNeural
 *   npm run fixture -- --rate -10%
 *   npm run fixture -- --tts espeak
 *   npm run fixture -- --list-voices
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testmediaDir = path.join(projectRoot, 'testmedia')
const ffmpegPath = path.join(projectRoot, 'tools', 'ffmpeg.exe')
const ffprobePath = path.join(projectRoot, 'tools', 'ffprobe.exe')

/**
 * A monologue about learning to listen. Chosen on purpose: it is the sort of
 * thing a learner would actually want to play, and it stays clear of digits,
 * abbreviations and contractions, all of which the engine may speak as words
 * that are not in the source text — which would break the word-to-sentence
 * mapping below.
 */
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
  'There is one more thing worth saying about all this.',
  'Nobody tells you that listening is a physical skill.',
  'Your ear gets tired the same way your legs do.',
  'Twenty minutes of real attention beats two hours of drifting.',
  'So I stopped measuring by how many episodes I finished.',
  'I started measuring by how many times I had to rewind.',
  'On a good day, the number goes down by one or two.',
  'On a bad day, it goes up, and that is fine.',
  'The point is not to understand everything.',
  'The point is to stay in the conversation until it ends.',
  'If you can do that, the meaning arrives on its own.',
  'It arrives late, usually, and then all at once.',
  'That is what people mean when they say it clicks.',
  'I am not fluent yet, and I have stopped pretending to be.',
  'But I can order coffee, argue about the weather, and ask for directions.',
  'Three months ago, none of that was true.',
]

const DEFAULTS = {
  sentences: SCRIPT.length,
  name: 'listening-fixture-01',
  tts: 'edge',
  voice: 'en-US-AndrewNeural',
  rate: '',
  leadInMs: 600,
  tailMs: 1400,
  listVoices: false,
  noProxy: false,
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    switch (token) {
      case '--sentences':
        options.sentences = Number(value) || options.sentences
        index += 1
        break
      case '--name':
        options.name = value ?? options.name
        index += 1
        break
      case '--tts':
        options.tts = value === 'espeak' ? 'espeak' : 'edge'
        index += 1
        break
      case '--voice':
        options.voice = value ?? options.voice
        index += 1
        break
      case '--rate':
        options.rate = value ?? options.rate
        index += 1
        break
      case '--lead-in':
        options.leadInMs = Number(value) || options.leadInMs
        index += 1
        break
      case '--tail':
        options.tailMs = Number(value) || options.tailMs
        index += 1
        break
      case '--list-voices':
        options.listVoices = true
        break
      case '--no-proxy':
        options.noProxy = true
        break
      default:
        if (token.startsWith('--')) {
          console.error(`Unknown option: ${token}`)
          process.exitCode = 1
        }
    }
  }
  return options
}

// The sandbox this project is developed inside exports HTTP(S)_PROXY pointing
// at a local egress proxy that resets requests to some hosts. The synthesis
// path speaks WebSocket, which ignores those variables, but voice *listing*
// goes through axios, which honours them.
function dropProxyEnv() {
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    delete process.env[key]
  }
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

/** Lower-cased words with punctuation removed — the shape the engine returns. */
function tokenize(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function normalizeToken(token) {
  return String(token).toLowerCase().replace(/[^a-z0-9']/g, '')
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

// ---------------------------------------------------------------------------
// WAV assembly (only the offline eSpeak backend needs this)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// backend: Microsoft Edge read-aloud (neural, needs the network)
// ---------------------------------------------------------------------------

/**
 * Turn the engine's word timeline back into the sentences we sent it.
 *
 * This is a strict match on purpose. If the engine ever speaks something that
 * is not in the source text — expanding a number, splitting a contraction — the
 * counts stop lining up and we want to know loudly, not produce a subtitle that
 * is quietly half a second out.
 */
function groupWordsIntoSentences(sentences, words) {
  const cues = []
  let cursor = 0

  for (const [index, sentence] of sentences.entries()) {
    const expected = tokenize(sentence)
    const slice = words.slice(cursor, cursor + expected.length)
    const spoken = slice.map((word) => normalizeToken(word.text))

    if (slice.length !== expected.length) {
      throw new Error(
        `Word boundaries ran out at sentence ${index + 1}.\n` +
          `  expected ${expected.length} word(s), got ${slice.length}\n` +
          `  sentence: ${sentence}`,
      )
    }

    const mismatch = expected.findIndex((token, position) => spoken[position] !== token)
    if (mismatch !== -1) {
      throw new Error(
        `Word ${mismatch + 1} of sentence ${index + 1} does not match.\n` +
          `  expected: "${expected[mismatch]}"\n` +
          `  spoken  : "${slice[mismatch].text}"\n` +
          `  sentence: ${sentence}\n` +
          `  around  : ${spoken.slice(Math.max(0, mismatch - 4), mismatch + 5).join(' ')}`,
      )
    }

    cues.push({
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      text: sentence,
    })
    cursor += expected.length
  }

  if (cursor !== words.length) {
    const extra = words.slice(cursor, cursor + 12).map((word) => word.text).join(' ')
    throw new Error(
      `${words.length - cursor} word(s) of speech were not covered by any sentence.\n` +
        `  trailing speech: ${extra}`,
    )
  }

  return cues
}

function readWordBoundaries(metadataFilePath) {
  const parsed = JSON.parse(fs.readFileSync(metadataFilePath, 'utf8'))
  const entries = Array.isArray(parsed.Metadata) ? parsed.Metadata : []

  return entries
    .filter((entry) => entry?.Type === 'WordBoundary' && entry.Data)
    .map((entry) => ({
      text: String(entry.Data.text?.Text ?? ''),
      // The protocol reports 100-nanosecond ticks.
      startMs: Number(entry.Data.Offset) / 10_000,
      endMs: (Number(entry.Data.Offset) + Number(entry.Data.Duration)) / 10_000,
    }))
    .sort((a, b) => a.startMs - b.startMs)
}

async function listEdgeVoices() {
  const { MsEdgeTTS } = require('msedge-tts')
  const voices = await new MsEdgeTTS().getVoices()
  const english = voices
    .filter((voice) => /^en-/.test(voice.Locale))
    .sort((a, b) => a.Locale.localeCompare(b.Locale) || a.ShortName.localeCompare(b.ShortName))

  console.log(`${voices.length} voices total, ${english.length} English:\n`)
  for (const voice of english) {
    console.log(`  ${voice.ShortName.padEnd(34)} ${voice.Gender.padEnd(7)} ${voice.FriendlyName}`)
  }
  console.log(`\nPick one with:  npm run fixture -- --voice <ShortName>`)
}

async function synthesiseWithEdge(sentences, options) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'el-fixture-'))

  try {
    const tts = new MsEdgeTTS()
    await tts.setMetadata(
      options.voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      { wordBoundaryEnabled: true },
    )

    const text = sentences.join(' ')
    console.log(`\nSynthesising ${sentences.length} sentence(s), ${text.length} chars`)
    console.log(`  voice: ${options.voice}${options.rate ? `   rate: ${options.rate}` : ''}`)

    const started = Date.now()
    const prosody = options.rate ? { rate: options.rate } : undefined
    const result = await tts.toFile(scratch, text, prosody)
    tts.close()
    console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`)

    if (!result.metadataFilePath) {
      throw new Error(
        'The engine returned audio but no word boundaries, so the subtitle ' +
          'cannot be timed. Re-run with --tts espeak to fall back offline.',
      )
    }

    const words = readWordBoundaries(result.metadataFilePath)
    const cues = groupWordsIntoSentences(sentences, words)

    return { audioPath: result.audioFilePath, cues, words, scratch }
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true })
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${detail}\n\n` +
        (options.noProxy
          ? 'The Edge endpoint was unreachable. Try again, or run with --tts espeak to stay offline.'
          : 'The Edge endpoint was unreachable. If you are behind an egress proxy, try --no-proxy. ' +
            'Or run with --tts espeak to stay offline.'),
    )
  }
}

// ---------------------------------------------------------------------------
// backend: eSpeak NG (offline, robotic)
// ---------------------------------------------------------------------------

const ESPEAK_GAP_MS = 700

async function synthesiseWithEspeak(sentences, options) {
  const ESpeakNg = (await import('espeak-ng')).default

  console.log(`\nSynthesising ${sentences.length} sentence(s) with eSpeak NG (en-us)…`)

  const rendered = []
  let format = null

  for (const text of sentences) {
    const espeak = await ESpeakNg({
      arguments: ['-w', 'line.wav', '-v', 'en-us', '-s', '150', '-p', '45', text],
    })
    const { format: lineFormat, data } = parseWav(Buffer.from(espeak.FS.readFile('line.wav')))

    if (!format) format = lineFormat
    else if (
      lineFormat.sampleRate !== format.sampleRate ||
      lineFormat.channels !== format.channels ||
      lineFormat.bitsPerSample !== format.bitsPerSample
    ) {
      throw new Error('eSpeak produced inconsistent sample formats between lines')
    }

    rendered.push({ text, data, durationMs: (data.length / lineFormat.byteRate) * 1000 })
  }

  const chunks = [silenceBytes(format, options.leadInMs)]
  const cues = []
  let cursorMs = options.leadInMs

  for (const line of rendered) {
    cues.push({ startMs: cursorMs, endMs: cursorMs + line.durationMs, text: line.text })
    chunks.push(line.data)
    chunks.push(silenceBytes(format, ESPEAK_GAP_MS))
    cursorMs += line.durationMs + ESPEAK_GAP_MS
  }

  chunks.push(silenceBytes(format, options.tailMs))

  const wavPath = path.join(testmediaDir, `${options.name}.wav`)
  fs.writeFileSync(wavPath, buildWavBuffer(format, Buffer.concat(chunks)))

  return { audioPath: wavPath, cues, words: [], scratch: null }
}

// ---------------------------------------------------------------------------
// shared tail
// ---------------------------------------------------------------------------

/**
 * A cue ends where the next one starts, so the highlighted line is always the
 * line whose speech has begun. Left as-is, the pause between sentences would
 * briefly highlight nothing at all, which reads as a glitch rather than as a
 * gap — and when a line is looped, the trailing pause is part of what you want
 * to hear anyway.
 */
function bridgeCues(cues, tailMs) {
  for (let index = 0; index < cues.length - 1; index += 1) {
    cues[index].endMs = cues[index + 1].startMs
  }
  // Same rule to the end of the file: the last line stays lit until playback
  // does, rather than blinking out over the trailing silence.
  cues[cues.length - 1].endMs += tailMs
  return cues
}

function shiftCues(cues, deltaMs) {
  for (const cue of cues) {
    cue.startMs += deltaMs
    cue.endMs += deltaMs
  }
  return cues
}

function writeVtt(cues, filePath) {
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n')
  fs.writeFileSync(filePath, ['WEBVTT', '', body].join('\n'), 'utf8')
}

function probeDurationMs(filePath) {
  if (!fs.existsSync(ffprobePath)) return null
  const result = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8' },
  )
  const seconds = Number(String(result.stdout ?? '').trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

// ---------------------------------------------------------------------------
// the picture: ruled paper + the audio's own waveform
// ---------------------------------------------------------------------------

const FRAME_W = 1280
const FRAME_H = 720
const WAVE_H = 240
// Centred, so the wave's zero line sits exactly on the strong rule.
const WAVE_TOP = Math.round((FRAME_H - WAVE_H) / 2)
const WAVE_COLOUR = '0x0d9488' // the app's --color-accent
const WAVE_ALPHA = 0.6

// Fonts we can name directly. drawtext wants a file, and fontconfig is not
// something this 2018 build can be relied on to consult.
const CAPTION_FONTS = [
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
]

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function writePng(filePath, rgb, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour

  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0 // filter: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3)
  }

  fs.writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * The background: a mint "ruled paper" wash, drawn per pixel into a PNG.
 *
 * Two things this does NOT do, on purpose. It does not put text or progress in
 * the frame — the transcript panel is the reading surface and the transport is
 * the progress indicator; duplicating either on the picture is noise. And it
 * does not animate: the waveform over it is the only motion, and that one is
 * honest, because it is the audio itself.
 */
function makeBackground(filePath) {
  const px = Buffer.alloc(FRAME_W * FRAME_H * 3)
  // The strong rule is the wave's zero line; the faint ones frame its band.
  const rules = [
    { y: WAVE_TOP - 4, c: [186, 214, 207], a: 0.55 },
    { y: WAVE_TOP + WAVE_H / 2, c: [168, 204, 196], a: 0.9 },
    { y: WAVE_TOP + WAVE_H + 4, c: [186, 214, 207], a: 0.55 },
  ]
  const glow = { x: 1010, y: 150, r: 620 }

  for (let y = 0; y < FRAME_H; y += 1) {
    const t = y / (FRAME_H - 1)
    const baseR = lerp(243, 226, t)
    const baseG = lerp(249, 240, t)
    const baseB = lerp(246, 236, t)

    for (let x = 0; x < FRAME_W; x += 1) {
      const dx = (x - glow.x) / glow.r
      const dy = (y - glow.y) / glow.r
      const falloff = Math.max(0, 1 - (dx * dx + dy * dy)) ** 2
      // Blend TOWARD white rather than adding to the channels. These values are
      // already in the high 240s; adding wraps them around 256, which painted a
      // magenta ring across the first prototype. Blending cannot overflow.
      let r = lerp(baseR, 255, falloff * 0.45)
      let g = lerp(baseG, 255, falloff * 0.45)
      let b = lerp(baseB, 255, falloff * 0.45)

      for (const rule of rules) {
        const dist = Math.abs(y - rule.y)
        if (dist <= 1) {
          const k = rule.a * (1 - dist * 0.5)
          r = lerp(r, rule.c[0], k)
          g = lerp(g, rule.c[1], k)
          b = lerp(b, rule.c[2], k)
        }
      }

      const i = (y * FRAME_W + x) * 3
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
    }
  }

  writePng(filePath, px, FRAME_W, FRAME_H)
}

/** drawtext's filter string has its own escaping rules; sidestep them. */
function captionSafe(text) {
  return text.replace(/[^A-Za-z0-9 ._-]/g, '-').replace(/\s+/g, ' ').trim()
}

function mux(audioPath, outPath, options, backgroundPath) {
  // Total length is computed rather than asked for, because `apad` lengths its
  // pad by sample count on older builds (`pad_dur` does not exist yet), so the
  // pad is left open-ended and the output is cut with -t instead.
  const sourceMs = probeDurationMs(audioPath)
  const totalMs = sourceMs === null ? null : sourceMs + options.leadInMs + options.tailMs

  const audioChain = []
  if (options.leadInMs > 0) audioChain.push(`adelay=${options.leadInMs}`)
  if (options.tailMs > 0 && totalMs !== null) audioChain.push('apad')
  const padPrefix = audioChain.length ? audioChain.join(',') + ',' : ''

  // One audio chain, split two ways: [af] becomes the file's own audio track,
  // [aw] feeds the waveform so the picture and the sound can never disagree.
  // The caption is drawn inside this graph, not via -vf: ffmpeg refuses a
  // -filter option on a stream that a complex filtergraph is already feeding.
  const caption = captionSafe(
    `${options.name} — ${options.tts === 'edge' ? options.voice : 'eSpeak NG (offline)'}`,
  )
  const font = CAPTION_FONTS.find((candidate) => fs.existsSync(candidate))
  const withCaption = Boolean(font)
  const tail = withCaption ? '[ovl]' : '[v]'

  const graph =
    `[1:a]${padPrefix}asplit=2[af][aw];` +
    `[aw]showwaves=s=${FRAME_W}x${WAVE_H}:mode=cline:rate=25:colors=${WAVE_COLOUR},` +
    `format=rgba,colorchannelmixer=aa=${WAVE_ALPHA}[wv];` +
    `[0:v][wv]overlay=0:${WAVE_TOP}:shortest=1${tail}` +
    (withCaption
      ? `;[ovl]drawtext=fontfile=${font.replace(/:/g, '\\:')}:text='${caption}':` +
        `fontsize=22:fontcolor=0x829e97:x=72:y=h-th-56[v]`
      : '')

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-loop', '1',
    '-framerate', '25',
    '-i', backgroundPath,
    '-i', audioPath,
    '-filter_complex', graph,
    '-map', '[v]',
    '-map', '[af]',
  ]

  args.push(
    // One-second keyframes, matching the "practice proxy" note in the design
    // doc — which makes this file a fair test for seek latency.
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
  )

  if (totalMs === null) args.push('-shortest')
  else args.push('-t', (totalMs / 1000).toFixed(3))

  args.push(outPath)

  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed:\n${result.stderr || result.stdout}`)
  }
}

function report(cues) {
  const width = Math.max(...cues.map((cue) => formatTimestamp(cue.startMs).length))
  for (const [index, cue] of cues.entries()) {
    const start = formatTimestamp(cue.startMs).padStart(width)
    const end = formatTimestamp(cue.endMs)
    console.log(`  ${String(index + 1).padStart(3)}  ${start} → ${end}  ${cue.text}`)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.noProxy) dropProxyEnv()

  if (options.listVoices) {
    await listEdgeVoices()
    return
  }

  const sentences = SCRIPT.slice(0, Math.min(options.sentences, SCRIPT.length))

  if (!fs.existsSync(ffmpegPath)) {
    console.error(`ffmpeg not found at ${ffmpegPath}\nRun: npm run tools:install`)
    process.exitCode = 1
    return
  }

  fs.mkdirSync(testmediaDir, { recursive: true })
  console.log(`Backend: ${options.tts === 'edge' ? 'Microsoft Edge read-aloud (neural)' : 'eSpeak NG (offline)'}`)

  const renderScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'el-fixture-'))
  const backgroundPath = path.join(renderScratch, 'background.png')

  const { audioPath, cues, words, scratch: synthesisScratch } =
    options.tts === 'espeak'
      ? await synthesiseWithEspeak(sentences, options)
      : await synthesiseWithEdge(sentences, options)

  try {
    bridgeCues(cues, options.tailMs)
    if (options.tts === 'edge') {
      // The engine's own clock starts at zero; our timeline starts after the
      // lead-in silence that ffmpeg prepends.
      shiftCues(cues, options.leadInMs)
    }

    const vttPath = path.join(testmediaDir, `${options.name}.vtt`)
    writeVtt(cues, vttPath)

    const mp4Path = path.join(testmediaDir, `${options.name}.mp4`)
    console.log(`\nDrawing the picture (ruled paper + the audio's own waveform)…`)
    makeBackground(backgroundPath)
    console.log(`Muxing video (1-second keyframes)…`)
    mux(audioPath, mp4Path, options, backgroundPath)

    const durationMs = probeDurationMs(mp4Path)
    const wordsPerSecond = words.length && durationMs ? (words.length / (durationMs / 1000)).toFixed(2) : null

    console.log(`\nTimeline:`)
    report(cues)

    console.log(`\nFixture ready:`)
    console.log(`  ${mp4Path}`)
    console.log(`  ${vttPath}  (sidecar — picked up automatically on import)`)

    const summary = [`${cues.length} lines`]
    if (words.length) summary.push(`${words.length} spoken words`)
    if (durationMs) summary.push(`${(durationMs / 1000).toFixed(1)}s total`)
    if (wordsPerSecond) summary.push(`${wordsPerSecond} words/s`)
    console.log(`\n${summary.join(', ')}`)
    if (options.tts === 'edge') {
      console.log(
        `\nCue times are the engine's own word boundaries — line 1 starts at the\n` +
          `spoken onset of its first word (+${options.leadInMs}ms lead-in). If the highlight and the\n` +
          `audio disagree, the player is wrong, not the fixture.`,
      )
    }
  } finally {
    // The assembled wav, the background PNG and the Edge scratch dir are all
    // intermediates; the audio was already consumed into the mp4.
    if (options.tts === 'espeak') fs.rmSync(audioPath, { force: true })
    if (synthesisScratch) fs.rmSync(synthesisScratch, { recursive: true, force: true })
    fs.rmSync(renderScratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
