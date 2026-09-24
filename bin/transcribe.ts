#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { computeFingerprint, normalizeInputPath } from '../lib/server/path'
import { getLessonRow, getLessonRowByDigest, listLessons } from '../lib/server/repo'
import { resolveAsrTools } from '../lib/server/asr'
import { STAGE_LABELS } from '../lib/lesson/stages'
import {
  cancelJob,
  listJobs,
  startTranscription,
  subscribe,
  type TranscribeJob,
} from '../lib/server/transcribe'

/**
 * CLI front door for the transcription pipeline.
 *
 * Like `bin/ingest.ts`, it drives the same `startTranscription` the HTTP route
 * does, so the two cannot drift. And like it, the point is being able to run the
 * whole pipeline with no UI at all — which is how this was developed, and how a
 * failure in ffmpeg or whisper.cpp gets diagnosed without a browser in the loop.
 *
 *   npm run transcribe -- --list
 *   npm run transcribe -- c5a557c6fa29
 *   npm run transcribe -- "F:\videos\ep01.mp4"
 *   npm run transcribe -- --all-missing
 *   npm run transcribe -- c5a557c6fa29 --model large-v3-turbo-q8_0 --force
 */

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false
const paint = (code: number) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)
const bold = paint(1)
const dim = paint(2)
const green = paint(32)
const yellow = paint(33)
const red = paint(31)
const cyan = paint(36)

type ParsedArgs = {
  target: string | null
  model?: string
  language?: string
  force: boolean
  list: boolean
  allMissing: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    target: null,
    force: false,
    list: false,
    allMissing: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--list':
      case '-l':
        args.list = true
        break
      case '--force':
      case '-f':
        args.force = true
        break
      case '--all-missing':
        args.allMissing = true
        break
      case '--model':
        args.model = argv[++index]
        break
      case '--language':
      case '--lang':
        args.language = argv[++index]
        break
      default:
        if (token.startsWith('-')) throw new Error(`Unknown option: ${token}`)
        if (args.target === null) args.target = token
        break
    }
  }

  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      bold('english-listening · transcribe'),
      '',
      'Usage:',
      '  npm run transcribe -- --list',
      '  npm run transcribe -- <lesson-id | id-prefix | title-substring>',
      '  npm run transcribe -- "<path to a video or audio file>"',
      '  npm run transcribe -- --all-missing',
      '',
      'Options:',
      '  --model <name>       Which staged model to use (default: base.en-q8_0)',
      '  --language <code>    Spoken language (default: en)',
      '  --force              Re-transcribe even if the lesson already has lines',
      '  --all-missing        Transcribe every lesson that has no transcript yet',
      '  --list               Show the library and what still needs a transcript',
      '  --help               Show this message',
      '',
      dim('Runs entirely on this machine. The source file is only ever read.'),
      '',
    ].join('\n'),
  )
}

function formatDuration(ms: number | null): string {
  if (!ms) return '--:--'
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function showLibrary(): void {
  const lessons = listLessons()
  if (lessons.length === 0) {
    process.stdout.write(`${dim('The library is empty. Run npm run ingest first.')}\n`)
    return
  }

  process.stdout.write(`${bold(`${lessons.length} lesson(s) in the library`)}\n\n`)
  let missing = 0
  for (const lesson of lessons) {
    const state = lesson.missingSince
      ? red('source missing')
      : lesson.cueCount > 0
        ? green(`${lesson.cueCount} lines (${lesson.transcriptSource})`)
        : yellow('no transcript')
    if (lesson.cueCount === 0 && !lesson.missingSince) missing += 1
    process.stdout.write(`  ${cyan(lesson.id)}  ${bold(lesson.title)}\n`)
    process.stdout.write(`    ${dim(formatDuration(lesson.durationMs))} · ${state}\n`)
  }
  process.stdout.write(
    `\n${missing > 0 ? yellow(`${missing} lesson(s) need a transcript.`) : green('Everything has a transcript.')}\n`,
  )
}

/**
 * Accept an id, an unambiguous id prefix, a title substring, or a path.
 *
 * The path case is worth the fingerprint: it means the CLI can be pointed at a
 * file the same way `npm run ingest` is, without the user having to know the id
 * the app derived.
 */
async function resolveTarget(target: string): Promise<string | null> {
  const lessons = listLessons()

  const exact = lessons.find((lesson) => lesson.id === target)
  if (exact) return exact.id

  const lowered = target.toLowerCase()
  const byPrefix = lessons.filter((lesson) => lesson.id.toLowerCase().startsWith(lowered))
  if (byPrefix.length === 1) return byPrefix[0].id
  if (byPrefix.length > 1) {
    process.stderr.write(`${red(`"${target}" matches ${byPrefix.length} lessons. Be more specific.`)}\n`)
    return null
  }

  const byTitle = lessons.filter((lesson) => lesson.title.toLowerCase().includes(lowered))
  if (byTitle.length === 1) return byTitle[0].id
  if (byTitle.length > 1) {
    process.stderr.write(`${red(`"${target}" matches ${byTitle.length} titles. Use an id.`)}\n`)
    return null
  }

  // Last resort: treat it as a path and match on content fingerprint.
  const candidate = normalizeInputPath(target)
  if (fs.existsSync(candidate)) {
    const fingerprint = await computeFingerprint(candidate)
    const row = getLessonRowByDigest(fingerprint.digest)
    if (row) return row.id
    process.stderr.write(
      `${red(`${path.basename(candidate)} is not in the library. Import it first:`)}\n` +
        `  npm run ingest -- "${candidate}"\n`,
    )
    return null
  }

  process.stderr.write(`${red(`Nothing matches "${target}". Try --list.`)}\n`)
  return null
}

const STAGE_LABEL: Record<string, string> = STAGE_LABELS

/** Wait for a job to reach a terminal stage, printing progress as it goes. */
function followJob(jobId: string): Promise<TranscribeJob> {
  const interactive = process.stdout.isTTY === true && !process.env.NO_COLOR
  let lastLine = ''
  let lastStage = ''
  let lastBucket = -2

  return new Promise((resolve, reject) => {
    const unsubscribe = subscribe(jobId, (job) => {
      const label = STAGE_LABEL[job.stage] ?? job.stage
      const bar = `${String(job.percent).padStart(3)}%`

      if (interactive) {
        const line = `  ${bar}  ${label}${job.detail && job.detail !== label ? dim(` · ${job.detail}`) : ''}`
        // Pad so a shorter line cannot leave the tail of the previous one visible.
        process.stdout.write(`\r${line.padEnd(lastLine.length, ' ')}`)
        lastLine = line
      } else {
        // Non-TTY (piped, CI, or NO_COLOR): one line per stage change, plus one
        // per 10% inside a stage. Printing every update would be hundreds of
        // lines for a long file, but printing only stage changes would hide the
        // transcription progress completely — and that stage is the whole wait.
        const bucket = job.stagePercent === null ? -1 : Math.floor(job.stagePercent / 10)
        if (job.stage !== lastStage || bucket !== lastBucket) {
          lastStage = job.stage
          lastBucket = bucket
          process.stdout.write(`  ${bar}  ${label}${job.detail ? ` · ${job.detail}` : ''}\n`)
        }
      }

      if (job.stage === 'done' || job.stage === 'failed' || job.stage === 'cancelled') {
        unsubscribe()
        if (interactive) process.stdout.write('\n')
        if (job.stage === 'cancelled') reject(new Error('Cancelled.'))
        else if (job.stage === 'failed') reject(new Error(job.error ?? 'Transcription failed.'))
        else resolve(job)
      }
    })
  })
}

async function transcribeOne(
  lessonId: string,
  args: ParsedArgs,
  counters: { done: number; failed: number; skipped: number },
): Promise<void> {
  const row = getLessonRow(lessonId)
  if (!row) {
    counters.failed += 1
    process.stderr.write(`${red(`No such lesson: ${lessonId}`)}\n`)
    return
  }

  process.stdout.write(`\n${bold(row.title)}  ${dim(lessonId)}\n`)

  const started = startTranscription({
    lessonId,
    model: args.model,
    language: args.language,
    force: args.force,
  })

  if (!started.ok) {
    const { problem } = started
    if (problem.kind === 'has-transcript') {
      counters.skipped += 1
      process.stdout.write(`  ${yellow('skipped')} — ${problem.message}\n`)
      return
    }
    counters.failed += 1
    process.stdout.write(`  ${red('cannot start')} — ${problem.message}\n`)
    if (problem.remedy) process.stdout.write(`  ${dim(problem.remedy)}\n`)
    return
  }

  const job = started.job
  process.stdout.write(`  ${dim(`job ${job.id} · ${job.model}${job.vad ? ' · vad' : ' · no vad'}`)}\n`)
  for (const warning of job.warnings) process.stdout.write(`  ${yellow('!')} ${warning}\n`)

  try {
    const finished = await followJob(job.id)
    counters.done += 1
    process.stdout.write(`  ${green('done')} — ${finished.cueCount} lines\n`)
    for (const warning of finished.warnings) process.stdout.write(`  ${yellow('!')} ${warning}\n`)
    process.stdout.write(`  ${dim(`open: http://127.0.0.1:4317/watch/${lessonId}`)}\n`)
  } catch (error) {
    counters.failed += 1
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  ${red('failed')} — ${message}\n`)
  }
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

  if (args.help) {
    printHelp()
    return 0
  }

  if (args.list || (!args.target && !args.allMissing)) {
    showLibrary()
    if (!args.list && !args.target && !args.allMissing) {
      process.stdout.write(`${dim('Tip: pass a lesson id, a path, or --all-missing.')}\n`)
    }
    return 0
  }

  // Fail before touching any media if the toolchain is not there. Extracting a
  // 40 MB wav only to discover whisper-cli is missing is a waste of the user's
  // time and, on a big file, of a minute of it.
  const tools = resolveAsrTools({ model: args.model })
  if (!tools.ok) {
    process.stderr.write(`${red(tools.problem.message)}\n${dim(tools.problem.remedy)}\n`)
    return 2
  }
  process.stdout.write(
    `${dim(`tools: ${tools.tools.cli}`)}\n` +
      `${dim(`model: ${tools.tools.model.name} (-dtw ${tools.tools.model.dtw})`)}\n` +
      `${dim(`vad:   ${tools.tools.vad ?? '(not staged — running without --vad)'}`)}\n`,
  )

  const counters = { done: 0, failed: 0, skipped: 0 }

  if (args.allMissing) {
    const pending = listLessons().filter(
      (lesson) => lesson.cueCount === 0 && !lesson.missingSince,
    )
    if (pending.length === 0) {
      process.stdout.write(`${green('Every lesson already has a transcript.')}\n`)
      return 0
    }
    process.stdout.write(`${bold(`Transcribing ${pending.length} lesson(s)`)}\n`)
    for (const lesson of pending) {
      await transcribeOne(lesson.id, args, counters)
    }
  } else {
    const lessonId = await resolveTarget(args.target as string)
    if (!lessonId) return 2
    await transcribeOne(lessonId, args, counters)
  }

  process.stdout.write(
    `\n${bold('Summary')}  ${green(`${counters.done} transcribed`)} · ` +
      `${counters.skipped > 0 ? yellow(`${counters.skipped} skipped`) : dim('0 skipped')} · ` +
      `${counters.failed > 0 ? red(`${counters.failed} failed`) : dim('0 failed')}\n`,
  )

  return counters.failed > 0 ? 1 : 0
}

// Ctrl-C must stop whisper.cpp, not just the CLI. Without this, the child keeps
// running headless and the next attempt fights it for the CPU.
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
