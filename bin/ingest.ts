#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { IngestError, ingestFile, type IngestStage } from '../lib/server/ingest'
import { listLessons } from '../lib/server/repo'
import { loadConfig } from '../lib/server/config'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../lib/server/path'

/**
 * CLI front door for the ingest pipeline.
 *
 * It calls exactly the same `ingestFile` the HTTP route does, so "import via the
 * web UI" and "import via the CLI" can never drift apart. It exists because it
 * lets the pipeline be driven (and debugged) with no UI at all:
 *
 *   npm run ingest -- "F:\videos\ep01.mp4"
 *   npm run ingest -- "F:\videos\ep01.mp4" --subtitle "F:\subs\ep01.en.srt"
 *   npm run ingest -- "F:\videos\S01"
 *   npm run ingest -- "F:\videos\S01" --only 1,3
 *   npm run ingest -- --list
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
  title?: string
  subtitle?: string
  force: boolean
  list: boolean
  all: boolean
  only: number[]
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    target: null,
    force: false,
    list: false,
    all: false,
    only: [],
    dryRun: false,
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
      case '--all':
        args.all = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--title':
        args.title = argv[++index]
        break
      case '--subtitle':
      case '--from-srt':
      case '--from-vtt':
        args.subtitle = argv[++index]
        break
      case '--only':
        args.only = (argv[++index] ?? '')
          .split(',')
          .map((piece) => Number(piece.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
        break
      default:
        if (token.startsWith('-')) {
          throw new IngestError(`Unknown option: ${token}`, 'bad-option')
        }
        if (args.target === null) args.target = token
        break
    }
  }

  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      bold('english-listening · ingest'),
      '',
      'Usage:',
      '  npm run ingest -- "<path to video or audio>" [options]',
      '  npm run ingest -- "<folder>" [--all | --only 1,3]',
      '  npm run ingest -- --list',
      '',
      'Options:',
      '  --title <text>       Override the lesson title',
      '  --subtitle <path>    Use a specific .srt / .vtt file',
      '  --force              Re-ingest even if the file was imported before',
      '  --dry-run            Resolve and probe only; do not write anything',
      '  --all                Import every media file found in a folder',
      '  --only 1,3           Import only the numbered candidates from the listing',
      '  --list               Show the current library',
      '  --help               Show this message',
      '',
      dim('Only files you name explicitly are ever imported. There is no folder scanning.'),
      '',
    ].join('\n'),
  )
}

const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])

function listMediaInFolder(folder: string): string[] {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(folder, entry.name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
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

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function showLibrary(): void {
  const lessons = listLessons()
  if (lessons.length === 0) {
    process.stdout.write(`${dim('The library is empty.')}\n`)
    return
  }

  process.stdout.write(`${bold(`${lessons.length} lesson(s) in the library`)}\n\n`)
  lessons.forEach((lesson) => {
    const status = lesson.missingSince
      ? red('source missing')
      : lesson.cueCount > 0
        ? green(`${lesson.cueCount} lines`)
        : yellow('no transcript')
    process.stdout.write(
      `  ${cyan(lesson.id)}  ${bold(lesson.title)}\n` +
        `    ${dim(formatDuration(lesson.durationMs))} · ${formatSize(lesson.sizeBytes)} · ${status} · ${dim(lesson.sourcePath)}\n`,
    )
  })
  process.stdout.write('\n')
}

const STAGE_LABEL: Record<IngestStage, string> = {
  resolving: 'Resolving path',
  fingerprinting: 'Fingerprinting file',
  probing: 'Probing media',
  subtitle: 'Looking for a transcript',
  writing: 'Writing lesson.json',
  done: 'Done',
}

async function importOne(
  filePath: string,
  args: ParsedArgs,
  counters: { created: number; reused: number; failed: number },
): Promise<void> {
  process.stdout.write(`\n${bold(path.basename(filePath))}\n`)

  let lastStage: IngestStage | null = null
  try {
    const report = await ingestFile({
      path: filePath,
      title: args.title,
      subtitlePath: args.subtitle,
      force: args.force,
      onProgress: (stage) => {
        if (args.dryRun || stage === lastStage) return
        lastStage = stage
        process.stdout.write(`  ${dim('·')} ${dim(STAGE_LABEL[stage])}\n`)
      },
    })

    if (report.reused) {
      counters.reused += 1
      process.stdout.write(`  ${yellow('already imported')} — lesson ${cyan(report.lessonId)}\n`)
    } else {
      counters.created += 1
      process.stdout.write(`  ${green('imported')} — lesson ${cyan(report.lessonId)}\n`)
    }

    const lines =
      report.cueCount > 0
        ? `${report.cueCount} lines from ${report.transcriptSource}`
        : dim('no transcript yet')
    process.stdout.write(`  ${lines}\n`)
    if (report.transcriptPath) {
      process.stdout.write(`  ${dim(report.transcriptPath)}\n`)
    }

    if (report.probe.available) {
      process.stdout.write(
        `  ${dim(
          `${formatDuration(report.probe.durationMs)} · audio ${report.probe.hasAudio ? 'yes' : 'no'} · embedded subtitles ${report.probe.embeddedSubtitleCount}`,
        )}\n`,
      )
    } else if (report.probe.error) {
      process.stdout.write(`  ${yellow(report.probe.error)}\n`)
    }

    for (const warning of report.warnings) {
      process.stdout.write(`  ${yellow('!')} ${warning}\n`)
    }

    process.stdout.write(
      `  ${dim('open:')} http://127.0.0.1:4317/watch/${report.lessonId}\n`,
    )
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

  const config = loadConfig()
  if (config.allowedRoots.length > 0) {
    process.stdout.write(`${dim(`Allowed roots: ${config.allowedRoots.join(', ')}`)}\n`)
  }

  if (args.list || !args.target) {
    showLibrary()
    if (!args.target && !args.list) {
      process.stdout.write(`${dim('Tip: pass a file or folder path, or use --help.')}\n`)
    }
    return 0
  }

  const target = path.resolve(args.target)
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    process.stderr.write(`${red(`Path not found: ${target}`)}\n`)
    return 2
  }

  const counters = { created: 0, reused: 0, failed: 0 }

  if (stat.isDirectory()) {
    const candidates = listMediaInFolder(target)
    if (candidates.length === 0) {
      process.stdout.write(`${dim(`No media files in ${target}`)}\n`)
      return 0
    }

    if (!args.all && args.only.length === 0) {
      process.stdout.write(`${bold(`${candidates.length} media file(s) in this folder`)}\n\n`)
      candidates.forEach((candidate, index) => {
        process.stdout.write(`  ${cyan(String(index + 1).padStart(3))}  ${path.basename(candidate)}\n`)
      })
      process.stdout.write(
        `\n${dim('Nothing was imported. Re-run with --all, or pick specific items with --only 1,3')}\n`,
      )
      return 0
    }

    const selected = args.all
      ? candidates
      : args.only.map((position) => candidates[position - 1]).filter(Boolean)

    if (selected.length === 0) {
      process.stderr.write(`${red('None of the --only positions matched a candidate.')}\n`)
      return 2
    }

    for (const candidate of selected) {
      await importOne(candidate, args, counters)
    }
  } else {
    await importOne(target, args, counters)
  }

  process.stdout.write(
    `\n${bold('Summary')}  ${green(`${counters.created} imported`)} · ${yellow(`${counters.reused} reused`)} · ${
      counters.failed > 0 ? red(`${counters.failed} failed`) : dim('0 failed')
    }\n`,
  )

  return counters.failed > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${red(error instanceof Error ? error.stack ?? error.message : String(error))}\n`)
    process.exitCode = 1
  })
