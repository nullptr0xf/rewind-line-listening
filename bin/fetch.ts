#!/usr/bin/env node
import { DOWNLOAD_STAGE_LABELS } from '../lib/lesson/stages'
import { loadConfig } from '../lib/server/config'
import {
  DEFAULT_PROBE_TARGET,
  PROXY_AUTO,
  probeTargetFor,
  resolveDownloader,
  resolveDownloadProxy,
} from '../lib/server/download-tools'
import {
  cancelJob,
  listJobs,
  startDownload,
  subscribe,
  type DownloadJob,
} from '../lib/server/download'

/**
 * CLI front door for the URL download.
 *
 * Like `bin/ingest.ts` and `bin/transcribe.ts`, it drives the same
 * `startDownload` the HTTP route does, so the two cannot drift. The reason to
 * have it is the same as for the others: when a download fails, having no
 * browser in the loop is the difference between a diagnosis and a guess.
 *
 *   npm run fetch -- https://www.youtube.com/watch?v=…
 *   npm run fetch -- <url> --video
 *   npm run fetch -- <url> --no-captions
 *   npm run fetch -- --doctor        # what will this actually use?
 */

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false
const paint = (code: number) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)
const bold = paint(1)
const dim = paint(2)
const green = paint(32)
const yellow = paint(33)
const red = paint(31)

type ParsedArgs = {
  url: string | null
  mode?: 'audio' | 'video'
  maxHeight?: number
  captions?: boolean
  language?: string
  outputDir?: string
  doctor: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { url: null, doctor: false, help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--doctor':
        args.doctor = true
        break
      case '--audio':
        args.mode = 'audio'
        break
      case '--video':
        args.mode = 'video'
        break
      case '--captions':
        args.captions = true
        break
      case '--no-captions':
        args.captions = false
        break
      case '--max-height': {
        const value = Number(argv[++index])
        if (!Number.isFinite(value) || value <= 0) throw new Error('--max-height needs a number.')
        args.maxHeight = value
        break
      }
      case '--language':
      case '--lang':
        args.language = argv[++index]
        break
      case '--out':
      case '--output-dir':
        args.outputDir = argv[++index]
        break
      default:
        if (token.startsWith('-')) throw new Error(`Unknown option: ${token}`)
        if (args.url === null) args.url = token
        break
    }
  }

  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      bold('english-listening · fetch'),
      '',
      'Usage:',
      '  npm run fetch -- <url>',
      '  npm run fetch -- --doctor [url]',
      '',
      'Options:',
      '  --audio              Audio stream only (the default)',
      '  --video              Keep the picture, capped at --max-height',
      '  --max-height <px>    Picture height cap when using --video (default: 720)',
      '  --no-captions        Do not fetch the site\'s own caption track',
      '  --lang <code>        Caption language (default: en)',
      '  --out <dir>          Where to save (default: data/media)',
      '  --doctor             Show the toolchain, the proxy and the destination, then exit',
      '                       Add a URL to health-check the proxy against that exact site',
      '  --help               Show this message',
      '',
      dim('The download ends in the same ingest pipeline as a local file, so the'),
      dim('result is an ordinary library entry — playable, loopable, transcribable.'),
      '',
    ].join('\n'),
  )
}

/**
 * Say what the download will actually use, before doing anything.
 *
 * This exists because the failure it prevents is almost invisible: youtube-dl
 * falls back to the Windows registry proxy when `--proxy` is omitted, so a stale
 * entry there produces a 502 that looks like the site blocking you. Printing the
 * resolved proxy turns a confusing symptom into a one-line answer.
 *
 * `url` is optional but worth passing: the proxy is health-checked against the
 * host the download will actually reach, so a proxy that works for YouTube but
 * not for Vimeo shows up here rather than three minutes into a failed download.
 */
async function doctor(url: string | null): Promise<number> {
  const config = loadConfig()
  const target = url ? probeTargetFor(url) : DEFAULT_PROBE_TARGET

  process.stdout.write(`${bold('Configuration')}\n`)
  process.stdout.write(`  ${dim('config file :')} ${config.downloader.proxy === PROXY_AUTO ? 'auto' : config.downloader.proxy}\n`)

  const downloader = await resolveDownloader({ config })
  if (!downloader.ok) {
    process.stdout.write(`  ${red('downloader  :')} ${downloader.problem.message}\n`)
    process.stdout.write(`  ${dim(downloader.problem.remedy)}\n`)
  } else {
    const { kind, command, prefix, cwd, origin, version } = downloader.downloader
    process.stdout.write(`  ${green('downloader  :')} ${kind} (${version})\n`)
    process.stdout.write(`  ${dim('found via   :')} ${origin}\n`)
    process.stdout.write(`  ${dim('command     :')} ${[command, ...prefix].join(' ')}\n`)
    if (cwd) process.stdout.write(`  ${dim('working dir :')} ${cwd}\n`)
  }

  const proxy = await resolveDownloadProxy({ config, target })
  if (proxy.url) {
    process.stdout.write(`  ${green('proxy       :')} ${proxy.url} ${dim(`(${proxy.source})`)}\n`)
  } else {
    process.stdout.write(`  ${yellow('proxy       :')} none — connecting directly\n`)
  }
  if (proxy.warning) process.stdout.write(`  ${yellow('!')} ${proxy.warning}\n`)
  process.stdout.write(
    `  ${dim('checked via :')} ${target.host}:${target.port}` +
      `${url ? '' : dim('  (default target — pass a URL to check the real one)')}\n`,
  )

  process.stdout.write(`  ${dim('saves into  :')} ${config.downloader.outputDir ?? config.managedMediaDir}\n`)
  process.stdout.write(
    `  ${dim('default     :')} ${config.downloader.audioOnly ? 'audio only' : `video ≤${config.downloader.maxHeight}p`}` +
      `${config.downloader.captions ? ' + captions' : ''}\n`,
  )

  return downloader.ok ? 0 : 2
}

/** Wait for a job to reach a terminal stage, printing progress as it goes. */
function followJob(jobId: string): Promise<DownloadJob> {
  const interactive = process.stdout.isTTY === true && !process.env.NO_COLOR
  let lastLine = ''
  let lastStage = ''
  let lastBucket = -2
  let lastDetail = ''

  return new Promise((resolve, reject) => {
    const unsubscribe = subscribe(jobId, (job) => {
      const label = DOWNLOAD_STAGE_LABELS[job.stage] ?? job.stage
      const bar = `${String(job.percent).padStart(3)}%`
      const rate = [job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean).join(' ')

      if (interactive) {
        const line =
          `  ${bar}  ${label}` +
          (job.detail && job.detail !== label ? dim(` · ${job.detail}`) : '') +
          (rate ? dim(`  ${rate}`) : '')
        // Pad so a shorter line cannot leave the tail of the previous one visible.
        process.stdout.write(`\r${line.padEnd(lastLine.length, ' ')}`)
        lastLine = line
      } else {
        // Non-TTY: one line per stage change, per 10% inside a stage, and per
        // detail change. Printing every update would be hundreds of lines.
        // The detail is suppressed when it merely repeats the stage label, which
        // is what every stage publishes before its step has reported anything.
        const bucket = job.stagePercent === null ? -1 : Math.floor(job.stagePercent / 10)
        const detail = job.detail && job.detail !== label ? job.detail : ''
        if (job.stage !== lastStage || bucket !== lastBucket || detail !== lastDetail) {
          lastStage = job.stage
          lastBucket = bucket
          lastDetail = detail
          process.stdout.write(`  ${bar}  ${label}${detail ? ` · ${detail}` : ''}\n`)
        }
      }

      if (job.stage === 'done' || job.stage === 'failed' || job.stage === 'cancelled') {
        unsubscribe()
        if (interactive) process.stdout.write('\n')
        if (job.stage === 'cancelled') reject(new Error('Cancelled.'))
        else if (job.stage === 'failed') reject(new Error(job.error ?? 'Download failed.'))
        else resolve(job)
      }
    })
  })
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  let args: ParsedArgs

  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${red(error instanceof Error ? error.message : String(error))}\n`)
    return 2
  }

  if (args.help || (!args.url && !args.doctor)) {
    printHelp()
    return args.help ? 0 : 2
  }

  if (args.doctor) return doctor(args.url)

  // Fail before opening a socket if there is nothing to download with.
  const tools = await resolveDownloader({ config: loadConfig() })
  if (!tools.ok) {
    process.stderr.write(`${red(tools.problem.message)}\n${dim(tools.problem.remedy)}\n`)
    return 2
  }
  process.stdout.write(`${dim(`downloader: ${tools.downloader.kind} (${tools.downloader.origin})`)}\n`)

  const started = await startDownload({
    url: args.url as string,
    mode: args.mode,
    maxHeight: args.maxHeight,
    captions: args.captions,
    language: args.language,
    outputDir: args.outputDir,
  })

  if (!started.ok) {
    const { problem } = started
    process.stderr.write(`${red('cannot start')} — ${problem.message}\n`)
    if (problem.remedy) process.stderr.write(`${dim(problem.remedy)}\n`)
    return 2
  }

  const job = started.job
  process.stdout.write(`${dim(`job ${job.id}`)}\n`)
  for (const warning of job.warnings) process.stdout.write(`  ${yellow('!')} ${warning}\n`)

  try {
    const finished = await followJob(job.id)
    process.stdout.write(`  ${green('done')}\n`)
    process.stdout.write(`  ${bold(finished.title || 'the video')}${finished.extractor ? dim(` (${finished.extractor})`) : ''}\n`)
    if (finished.filePath) process.stdout.write(`  ${dim(finished.filePath)}\n`)
    if (finished.lessonId) {
      process.stdout.write(
        `  ${finished.cueCount && finished.cueCount > 0
          ? `${finished.cueCount} lines from ${finished.transcriptSource}`
          : yellow('no captions — run npm run transcribe to make one')}\n`,
      )
      process.stdout.write(`  ${dim(`open: http://127.0.0.1:4317/watch/${finished.lessonId}`)}\n`)
    }
    for (const warning of finished.warnings) process.stdout.write(`  ${yellow('!')} ${warning}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`  ${red('failed')} — ${message}\n`)
    const proxy = await resolveDownloadProxy({ config: loadConfig(), target: probeTargetFor(args.url as string) })
    if (proxy.url) process.stderr.write(`  ${dim(`(this attempt used the proxy at ${proxy.url})`)}\n`)
    else process.stderr.write(`  ${dim('(this attempt went out with no proxy)')}\n`)
    return 1
  }
}

// Ctrl-C must stop the transfer, not just the CLI. Without this the downloader
// keeps writing into data/media headless, and the next attempt fights it for the
// same .part file.
process.on('SIGINT', () => {
  process.stderr.write('\n')
  for (const job of listJobs()) cancelJob(job.id)
  process.exitCode = 130
  setTimeout(() => process.exit(130), 200).unref()
})

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${red(error instanceof Error ? error.stack ?? error.message : String(error))}\n`)
    process.exitCode = 1
  })
