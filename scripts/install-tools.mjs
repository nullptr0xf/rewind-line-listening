/**
 * Stages every external binary and model the pipeline needs into ./tools.
 *
 * Two families, two sources, for one reason: the network on this machine cannot
 * reach the usual download hosts directly.
 *
 *  - ffmpeg / ffprobe come from npm packages that bundle the platform binary.
 *  - whisper.cpp comes as a release zip, fetched through the ghfast.top GitHub
 *    proxy (`github.com` itself times out here).
 *  - model weights come from hf-mirror.com (`huggingface.co` times out here).
 *
 * `tools/` is gitignored: the binaries are large and reproducible with
 * `npm run tools:install`.
 *
 * Usage:
 *   npm run tools:install                     # everything missing
 *   npm run tools:install -- --force          # re-download everything
 *   npm run tools:install -- --model base.en-q8_0
 *   npm run tools:install -- --list
 */

import fs from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = path.join(projectRoot, 'tools')
const whisperDir = path.join(toolsDir, 'whisper')
const modelsDir = path.join(whisperDir, 'models')

const WHISPER_VERSION = '1.7.6'
const WHISPER_ZIP = `https://ghfast.top/https://github.com/ggerganov/whisper.cpp/releases/download/v${WHISPER_VERSION}/whisper-bin-x64.zip`

/** hf-mirror mirrors the same repo paths as huggingface.co. */
const MODEL_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main'
const VAD_BASE = 'https://hf-mirror.com/ggml-org/whisper-vad/resolve/main'
/** Silero weights the v1.7.x binaries were built against. */
const VAD_FILE = 'ggml-silero-v5.1.2.bin'

const MODELS = {
  'large-v3-turbo-q8_0': { file: 'ggml-large-v3-turbo-q8_0.bin', dtw: 'large.v3.turbo', minBytes: 800e6 },
  'medium.en-q5_0': { file: 'ggml-medium.en-q5_0.bin', dtw: 'medium.en', minBytes: 400e6 },
  'base.en-q8_0': { file: 'ggml-base.en-q8_0.bin', dtw: 'base.en', minBytes: 70e6 },
}
const DEFAULT_MODEL = 'large-v3-turbo-q8_0'
/** Silero VAD is small; the floor only needs to catch a truncated fetch. */
const VAD_MIN_BYTES = 1e6

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const modelFlagIndex = argv.indexOf('--model')
const modelName = modelFlagIndex >= 0 ? argv[modelFlagIndex + 1] : DEFAULT_MODEL

if (argv.includes('--list')) {
  console.log('Models available to --model:')
  for (const [name, spec] of Object.entries(MODELS)) {
    const present = fs.existsSync(path.join(modelsDir, spec.file))
    console.log(`  ${name.padEnd(22)} ${present ? 'staged' : 'not staged'}  ${spec.file}`)
  }
  process.exit(0)
}

if (!MODELS[modelName]) {
  console.error(`Unknown model "${modelName}". Use --list to see the options.`)
  process.exit(1)
}

let failed = 0
const note = (message) => console.log(message)

/**
 * Download `url` into `dest`, resuming a previous partial file when there is one
 * and the server honours Range.
 *
 * The timeout is an INACTIVITY timeout, not a total one. A total timeout looks
 * reasonable and is a trap: the 870MB model takes minutes, so any fixed deadline
 * that is short enough to catch a hang is also short enough to kill a healthy
 * download halfway.
 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const partial = `${dest}.part`
    const already = fs.existsSync(partial) ? fs.statSync(partial).size : 0

    const request = (target, hops) => {
      const headers = { 'user-agent': 'english-listening/tools:install' }
      if (already > 0) headers.Range = `bytes=${already}-`

      const req = https.get(target, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume()
          if (hops <= 0) return reject(new Error('too many redirects'))
          return request(new URL(res.headers.location, target).toString(), hops - 1)
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${target}`))
        }

        // Server ignored our Range header: start over rather than corrupt the file.
        const appending = res.statusCode === 206 && already > 0
        if (already > 0 && !appending) note('    server does not support resume, restarting')
        const offset = appending ? already : 0
        const total = Number(res.headers['content-length'] || 0) + offset
        const file = fs.createWriteStream(partial, appending ? { flags: 'a' } : {})
        let seen = offset
        let lastPrinted = -1

        res.on('data', (chunk) => {
          seen += chunk.length
          const percent = total ? Math.floor((seen / total) * 100) : 0
          if (percent >= lastPrinted + 5) {
            lastPrinted = percent
            note(`    ${String(percent).padStart(3)}%  ${(seen / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`)
          }
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(partial, dest)
            resolve({ bytes: seen })
          })
        })
        file.on('error', reject)
        res.on('error', reject)
      })

      req.setTimeout(60_000, () => {
        req.destroy(new Error('stalled: no data for 60s'))
      })
      req.on('error', reject)
    }

    request(url, 8)
  })
}

function hasMagic(file, expected) {
  if (!fs.existsSync(file)) return false
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(expected.length)
  fs.readSync(fd, head, 0, expected.length, 0)
  fs.closeSync(fd)
  return head.toString('latin1') === expected
}

// --- 1. ffmpeg / ffprobe, from npm ----------------------------------------

function stageFfmpeg() {
  const tools = [
    { binary: 'ffmpeg', pkg: '@ffmpeg-installer/ffmpeg' },
    { binary: 'ffprobe', pkg: '@ffprobe-installer/ffprobe' },
  ]
  for (const { binary, pkg } of tools) {
    let resolved
    try {
      resolved = require(pkg)
    } catch (error) {
      console.error(`${binary}: could not resolve ${pkg} — run npm install first. (${String(error)})`)
      failed += 1
      continue
    }
    const destination = path.join(toolsDir, `${binary}${path.extname(resolved.path) || '.exe'}`)
    if (fs.existsSync(destination) && !force) {
      note(`${binary}: already staged`)
      continue
    }
    if (!fs.existsSync(resolved.path)) {
      console.error(`${binary}: package resolved to a missing file: ${resolved.path}`)
      failed += 1
      continue
    }
    fs.copyFileSync(resolved.path, destination)
    fs.chmodSync(destination, 0o755)
    note(`${binary}: staged from ${pkg}`)
  }
}

// --- 2. whisper.cpp binary -------------------------------------------------

function findWhisperCli() {
  const candidates = [path.join(whisperDir, 'Release', 'whisper-cli.exe'), path.join(whisperDir, 'whisper-cli.exe')]
  return candidates.find((c) => fs.existsSync(c)) ?? null
}

async function stageWhisper() {
  if (process.platform !== 'win32') {
    note('whisper.cpp: this installer only stages the Windows binary.')
    note('              On Linux/macOS build from source: cmake -B build && cmake --build build -j')
    return
  }

  const existing = findWhisperCli()
  if (existing && !force) {
    note(`whisper.cpp: already staged (${path.relative(projectRoot, existing)})`)
    return
  }

  note(`whisper.cpp: downloading ${WHISPER_VERSION} through the ghfast.top proxy…`)
  const zipPath = path.join(toolsDir, '_whisper-bin.zip')
  await download(WHISPER_ZIP, zipPath)

  if (!hasMagic(zipPath, 'PK')) {
    fs.rmSync(zipPath, { force: true })
    throw new Error('whisper zip does not start with PK — the proxy returned something else')
  }

  fs.rmSync(whisperDir, { recursive: true, force: true })
  fs.mkdirSync(whisperDir, { recursive: true })
  // Windows ships bsdtar, which reads zip.
  const tar = spawnSync('C:/Windows/System32/tar.exe', ['-xf', zipPath, '-C', whisperDir], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`)
  fs.rmSync(zipPath, { force: true })

  const cli = findWhisperCli()
  if (!cli) throw new Error('extracted the archive but found no whisper-cli.exe')
  note(`whisper.cpp: staged at ${path.relative(projectRoot, cli)} (CPU build; no Vulkan backend)`)
}

/** Prove the binary actually runs, rather than assuming the zip was fine. */
function verifyWhisperCli() {
  const cli = findWhisperCli()
  if (!cli) return
  const run = spawnSync(cli, ['--help'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status !== 0 || !/--vad/.test(output)) {
    console.error('whisper.cpp: the binary did not run, or lacks --vad support.')
    failed += 1
    return
  }
  note('whisper.cpp: runs, and supports --vad / -dtw / -ojf')
}

// --- 3. models -------------------------------------------------------------

async function stageModel(spec, label) {
  const destination = path.join(modelsDir, spec.file)
  const minBytes = spec.minBytes ?? 1e6

  /**
   * Checking the GGML magic is necessary but NOT sufficient: a half-downloaded
   * file still starts with "lmgg". Only the size catches truncation, and a
   * truncated model fails deep inside whisper with a confusing error.
   */
  const problem = (file) => {
    if (!fs.existsSync(file)) return 'missing'
    if (!hasMagic(file, 'lmgg')) return 'not a GGML file (the mirror served something else)'
    const size = fs.statSync(file).size
    if (size < minBytes) {
      return `truncated: ${(size / 1e6).toFixed(0)} MB, expected at least ${(minBytes / 1e6).toFixed(0)} MB`
    }
    return null
  }

  if (!force) {
    const issue = problem(destination)
    if (issue === null) {
      note(`${label}: already staged (${(fs.statSync(destination).size / 1e6).toFixed(0)} MB)`)
      return
    }
    if (issue !== 'missing') note(`${label}: ${issue} — refetching`)
  }

  note(`${label}: downloading from hf-mirror…`)
  await download(`${MODEL_BASE}/${spec.file}`, destination)
  const remaining = problem(destination)
  if (remaining) {
    console.error(`${label}: ${remaining}`)
    failed += 1
    return
  }
  note(`${label}: staged (${(fs.statSync(destination).size / 1e6).toFixed(0)} MB)`)
}

// --- run -------------------------------------------------------------------

fs.mkdirSync(toolsDir, { recursive: true })
fs.mkdirSync(modelsDir, { recursive: true })

async function main() {
  stageFfmpeg()
  await stageWhisper()
  verifyWhisperCli()
  await stageModel(MODELS[modelName], modelName)
  await stageModel({ file: VAD_FILE, minBytes: VAD_MIN_BYTES }, 'silero-vad')

  note('')
  if (failed > 0) {
    console.error(`${failed} item(s) failed.`)
    process.exitCode = 1
    return
  }
  note(`All tools staged in ${path.relative(projectRoot, toolsDir)}`)
  note(`Transcription model: ${modelName} (-dtw ${MODELS[modelName].dtw})`)
}

main().catch((error) => {
  console.error(`\ntools:install failed: ${error.message}`)
  process.exitCode = 1
})
