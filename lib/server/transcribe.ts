import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isFfmpegDone, parseFfmpegTime, parseWhisperProgress, resolveAsrTools, type StagedModel } from './asr'
import { CACHE_DIR, ensureDataDirs } from './config'
import { findTool, probeFile } from './probe'
import { getLessonRow, loadLesson, saveLesson, upsertLesson } from './repo'
import { DEFAULT_ASSEMBLE_OPTIONS, assembleWords, parseWhisperJson } from '../lesson/whisper'
import { DEFAULT_SEGMENT_OPTIONS, segmentWords, segmentationRecord } from '../lesson/segment'
import { SCHEMA_VERSION, type Cue, type CueWord, type Lesson } from '../lesson/schema'

/**
 * The transcription job runner: `ffmpeg → whisper-cli → lesson.json`.
 *
 * This is the piece that finally connects the two hard modules (§15.4) to the
 * app. Four decisions shape it:
 *
 * 1. **A job pushes full snapshots, never deltas.** Every state change emits the
 *    whole job object. That makes the SSE endpoint trivially correct — a client
 *    that connects halfway through, or reconnects after a dropped socket, needs
 *    no replay logic and cannot miss an event. The payload is a few hundred
 *    bytes and there is exactly one user on loopback.
 *
 * 2. **The whole toolchain is resolved before the first byte is written.** A
 *    missing model is a message, not a failure three stages in after a 40 MB wav
 *    has already been extracted.
 *
 * 3. **The pipeline is an injected list of steps.** `executeJob` knows about
 *    stages, progress arithmetic and cancellation; the steps know about ffmpeg
 *    and whisper. That split is what makes the risky part — a process-spawning
 *    state machine — testable without running either binary.
 *
 * 4. **A cancelled job is not a failed job.** They need opposite things from the
 *    user (nothing vs. a fix), so they are separate terminal stages even though
 *    both are reached through a thrown error.
 *
 * Pure Node: no `next/*` import, because `bin/transcribe.ts` drives this too.
 */

import { STAGE_LABELS, isTerminalStage, type TranscribeStage } from '../lesson/stages'

// Re-exported because TranscribeJob's `stage` field is this type, so anyone
// holding a job already depends on it.
export type { TranscribeStage }

export type TranscribeJob = {
  id: string
  lessonId: string
  title: string
  stage: TranscribeStage
  /** 0-100 across the whole job. */
  percent: number
  /** What is happening right now, in a form fit to show a user. */
  detail: string
  /** 0-100 within the current stage, when the stage can measure itself. */
  stagePercent: number | null
  model: string
  vad: boolean
  cueCount: number
  warnings: string[]
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** Bumped on every change, so a client can tell a stall from a stale frame. */
  revision: number
}

export type TranscribeProblemKind =
  | 'no-such-lesson'
  | 'already-running'
  | 'has-transcript'
  | 'no-audio'
  | 'source-missing'
  | 'toolchain'

export type TranscribeProblem = {
  kind: TranscribeProblemKind
  message: string
  /** The command or action that fixes it, when there is one. */
  remedy?: string
  /** Set for `already-running`, so the UI can attach to the job already going. */
  jobId?: string
}

export type StartResult = { ok: true; job: TranscribeJob } | { ok: false; problem: TranscribeProblem }

export type StartOptions = {
  lessonId: string
  model?: string
  language?: string
  /** Re-transcribe even when the lesson already has cues. */
  force?: boolean
  /** Override the injected pipeline. Tests use this. */
  steps?: PipelineStep[]
}

// --- the job registry --------------------------------------------------------

type Listener = (job: TranscribeJob) => void

export type JobRuntime = {
  snapshot: TranscribeJob
  listeners: Set<Listener>
  /** The process currently running, if any, so a cancel can actually reach it. */
  child: ChildProcess | null
  cancelled: boolean
}

/** What the executor needs from a job. Narrow on purpose: that is what tests fake. */
export type JobSink = {
  publish: (patch: Partial<TranscribeJob>) => void
  isCancelled: () => boolean
}

const CACHE_KEY = Symbol.for('english-listening.transcribe')

type GlobalWithJobs = typeof globalThis & { [CACHE_KEY]?: Map<string, JobRuntime> }

/**
 * Jobs live in memory, and only in memory. A transcription is a one-off action
 * whose result is persisted to lesson.json — there is nothing worth resuming
 * from a previous run of the app, so a durable job table would be storage
 * without a reader.
 *
 * It hangs off `globalThis` because Next.js re-evaluates modules on edit in dev,
 * and a job map that resets would orphan the SSE stream mid-transcription.
 */
function registry(): Map<string, JobRuntime> {
  const container = globalThis as GlobalWithJobs
  if (!container[CACHE_KEY]) container[CACHE_KEY] = new Map()
  return container[CACHE_KEY]
}

/** Finished jobs are kept so the UI can show the outcome, but not forever. */
const MAX_FINISHED_JOBS = 20

function prune(): void {
  const jobs = registry()
  const finished = [...jobs.values()].filter((runtime) => isTerminalStage(runtime.snapshot.stage))
  if (finished.length <= MAX_FINISHED_JOBS) return
  finished
    .sort((a, b) => (a.snapshot.finishedAt ?? '').localeCompare(b.snapshot.finishedAt ?? ''))
    .slice(0, finished.length - MAX_FINISHED_JOBS)
    .forEach((runtime) => jobs.delete(runtime.snapshot.id))
}

let sequence = 0
function nextJobId(): string {
  sequence += 1
  return `tr_${Date.now().toString(36)}_${sequence.toString(36)}`
}

export function makeRuntime(snapshot: TranscribeJob): JobRuntime {
  return { snapshot, listeners: new Set(), child: null, cancelled: false }
}

/**
 * Adapt a job to the narrow interface the executor uses. Kept separate so the
 * executor cannot reach into a job's listeners or child process — the tests fake
 * this interface, and a wider one would make them fake more than they need.
 */
export function sinkFor(runtime: JobRuntime): JobSink {
  return {
    publish: (patch) => publishTo(runtime, patch),
    isCancelled: () => runtime.cancelled,
  }
}

/** Mutates nothing about the job except its snapshot, then fans out to listeners. */
export function publishTo(runtime: JobRuntime, patch: Partial<TranscribeJob>): void {
  runtime.snapshot = { ...runtime.snapshot, ...patch, revision: runtime.snapshot.revision + 1 }
  const snapshot = runtime.snapshot
  for (const listener of runtime.listeners) {
    // A broken SSE socket must never take the job down with it.
    try {
      listener(snapshot)
    } catch {
      /* the listener's problem, not ours */
    }
  }
}

export function getJob(jobId: string): TranscribeJob | null {
  return registry().get(jobId)?.snapshot ?? null
}

export function listJobs(): TranscribeJob[] {
  return [...registry().values()]
    .map((runtime) => runtime.snapshot)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** The job currently working on a lesson, if any — how the UI reattaches after a reload. */
export function getActiveJobForLesson(lessonId: string): TranscribeJob | null {
  return (
    listJobs().find((job) => job.lessonId === lessonId && !isTerminalStage(job.stage)) ?? null
  )
}

export function subscribe(jobId: string, listener: Listener): () => void {
  const runtime = registry().get(jobId)
  if (!runtime) return () => {}
  runtime.listeners.add(listener)
  return () => {
    runtime.listeners.delete(listener)
  }
}

/**
 * Ask a job to stop. Killing the child makes its step's promise reject; the
 * executor then sees `cancelled` and lands on `cancelled` rather than `failed`.
 */
export function cancelJob(jobId: string): boolean {
  const runtime = registry().get(jobId)
  if (!runtime) return false
  if (isTerminalStage(runtime.snapshot.stage)) return false
  runtime.cancelled = true
  // Killing the child is what actually stops the work. The flag alone would
  // leave whisper.cpp burning a core until it finished the whole file.
  runtime.child?.kill()
  return true
}

// --- the pipeline contract ---------------------------------------------------

export type PipelineContext = {
  lessonId: string
  sourcePath: string
  model: StagedModel
  /** Validated `-dtw` value; guaranteed non-empty because resolution enforces it. */
  dtw: string
  cli: string
  vadPath: string | null
  language: string
  threads: number
  cacheDir: string
  /** Report progress inside the current stage. */
  report: (detail: string, stagePercent?: number | null) => void
  /** A non-fatal problem worth showing the user. */
  warn: (message: string) => void
  /** Registers the live child so a cancel can reach it. */
  track: (child: ChildProcess) => void
  isCancelled: () => boolean
}

/**
 * Build a context with inert defaults for the parts a caller does not care
 * about. Production passes real ones; the executor replaces `report` itself.
 */
export function makePipelineContext(
  overrides: Partial<PipelineContext> &
    Pick<PipelineContext, 'lessonId' | 'sourcePath' | 'model' | 'cacheDir'>,
): PipelineContext {
  return {
    dtw: overrides.model.dtw ?? '',
    cli: '',
    vadPath: null,
    language: 'en',
    threads: 1,
    report: () => {},
    warn: () => {},
    track: () => {},
    isCancelled: () => false,
    ...overrides,
  }
}

export type PipelineState = {
  /** From the index or ffprobe; the denominator for extraction progress. */
  durationMs: number | null
  wavPath: string | null
  jsonPath: string | null
  words: CueWord[]
  cues: Cue[]
  /** Warnings produced by the pure modules, worth persisting with the lesson. */
  transcriptWarnings: string[]
}

export type PipelineStep = {
  stage: TranscribeStage
  /** This stage's share of the progress bar. They deliberately sum to 100. */
  weight: number
  run: (state: PipelineState, ctx: PipelineContext) => Promise<Partial<PipelineState>>
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'JobCancelled'
  }
}

/** Thrown by a step for a condition that should reach the user verbatim. */
export class TranscribeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscribeError'
  }
}

/** The stage vocabulary lives in `lib/lesson/stages.ts` — see the note there. */

// --- the executor ------------------------------------------------------------

export const INITIAL_STATE: PipelineState = {
  durationMs: null,
  wavPath: null,
  jsonPath: null,
  words: [],
  cues: [],
  transcriptWarnings: [],
}

/**
 * Drives the steps, owns the progress arithmetic, and guarantees the properties
 * the UI depends on: percentages never go backwards or exceed 100, and each
 * stage's full weight is spent even when the stage cannot measure itself.
 *
 * Exported for tests: the risky logic here is the state machine, not the
 * binaries, and a fake step list exercises it in milliseconds.
 */
export async function executeJob(
  sink: JobSink,
  steps: PipelineStep[],
  ctx: PipelineContext,
  initial: PipelineState = INITIAL_STATE,
): Promise<PipelineState> {
  const total = steps.reduce((sum, step) => sum + step.weight, 0)
  if (total <= 0) throw new Error('executeJob needs at least one step with a positive weight.')

  // The span the current stage owns; `report` maps within it onto the whole bar.
  let base = 0
  let span = total

  const context: PipelineContext = {
    ...ctx,
    report: (detail, stagePercent = null) => {
      const within = stagePercent === null ? 0 : Math.max(0, Math.min(100, stagePercent))
      const overall = (base + (span * within) / 100) / total
      sink.publish({
        detail,
        stagePercent,
        percent: Math.max(0, Math.min(100, Math.round(overall * 100))),
      })
    },
  }

  let state = initial

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (sink.isCancelled()) throw new JobCancelled()

    span = step.weight
    sink.publish({
      stage: step.stage,
      detail: STAGE_LABELS[step.stage],
      stagePercent: null,
    })

    const patch = await step.run(state, context)
    state = { ...state, ...patch }

    // Land exactly on the stage boundary, so a stage that never reports its own
    // percentage still advances the bar by its full weight.
    base += step.weight
    span = 0
    sink.publish({ stagePercent: 100, percent: Math.round((base / total) * 100) })
  }

  return state
}

// --- the real pipeline ------------------------------------------------------

/** Longest we keep of a child's stderr. A long file emits thousands of progress lines. */
const STDERR_TAIL_BYTES = 4096

/**
 * Run a child process, handing each output line to a callback.
 *
 * Deliberately does NOT accumulate full output: whisper.cpp narrates every
 * segment it decodes, and holding that for a 45-minute file is pure waste. Only
 * a bounded tail of STDERR is kept — stdout carries ffmpeg's progress machine
 * chatter and would otherwise drown the error messages that matter.
 */
function runProcess(
  command: string,
  args: string[],
  options: {
    onStdout?: (line: string) => void
    onStderr?: (line: string) => void
    onSpawn?: (child: ChildProcess) => void
  } = {},
): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    options.onSpawn?.(child)

    let stderrTail = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const drain = (buffer: string, line: (value: string) => void) => {
      const parts = buffer.split(/\r?\n/)
      const rest = parts.pop() ?? ''
      for (const part of parts) line(part)
      return rest
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      stdoutBuffer = drain(stdoutBuffer, options.onStdout ?? (() => {}))
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      stderrBuffer += chunk
      stderrBuffer = drain(stderrBuffer, options.onStderr ?? (() => {}))
    })

    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderrTail }))
  })
}

/** The last few non-empty lines of a child's stderr — where the real error is. */
function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ')
}

export function cacheDirFor(lessonId: string): string {
  return path.join(CACHE_DIR, lessonId)
}

/** True when the cached artefact is at least as new as the file it came from. */
function isFresh(artefact: string, source: string): boolean {
  try {
    return fs.statSync(artefact).mtimeMs >= fs.statSync(source).mtimeMs
  } catch {
    return false
  }
}

/**
 * The `whisper-cli` invocation, as a pure function.
 *
 * Every flag here is load-bearing and every one of them fails *quietly* if
 * dropped, which is why this is separated out and tested rather than inlined:
 *
 *   `-pp`   print-progress defaults to **false**. Without it whisper.cpp emits
 *           no progress at all — measured: 131 stderr lines on a 124s file, not
 *           one of them a percentage. The transcription stage is 80% of the
 *           wait, so this one flag is the difference between a progress bar and
 *           a bar that sits still.
 *   `-ojf`  -oj emits no per-token data, so there is no word timeline.
 *   `-dtw`  word-level timings; without it `t_dtw` is absent entirely.
 *   `--vad` changes which timeline the token positions live in — see §15.10,
 *           where getting this out of sync with the assembler shifted every cue
 *           early by all the silence skipped so far.
 */
export function buildWhisperArgs(options: {
  modelPath: string
  wavPath: string
  prefix: string
  language: string
  dtw: string
  threads: number
  vadPath: string | null
}): string[] {
  const args = [
    '-m',
    options.modelPath,
    '-f',
    options.wavPath,
    '-l',
    options.language,
    '-ojf',
    '-of',
    options.prefix,
    '-dtw',
    options.dtw,
    '-t',
    String(options.threads),
    '-pp',
  ]
  if (options.vadPath) args.push('--vad', '-vm', options.vadPath)
  return args
}

export function makeDefaultSteps(): PipelineStep[] {
  return [
    {
      stage: 'probing',
      weight: 2,
      async run(state, ctx) {
        const row = getLessonRow(ctx.lessonId)
        if (!row) throw new TranscribeError('The lesson disappeared from the library.')
        if (row.missing_since) {
          throw new TranscribeError(
            `The source file is missing, so there is nothing to transcribe: ${row.source_path}`,
          )
        }

        // The index already has a duration from import time; ffprobe here is
        // only a fallback, and it is fine for it to fail.
        if (row.duration_ms) {
          ctx.report(`${(row.duration_ms / 1000).toFixed(0)}s of media`)
          return { durationMs: row.duration_ms }
        }
        const probe = await probeFile(ctx.sourcePath)
        ctx.report(probe.durationMs ? `${(probe.durationMs / 1000).toFixed(0)}s of media` : 'Duration unknown')
        return { durationMs: probe.durationMs ?? null }
      },
    },

    {
      stage: 'extracting',
      weight: 8,
      async run(state, ctx) {
        ensureDataDirs()
        fs.mkdirSync(ctx.cacheDir, { recursive: true })
        const wav = path.join(ctx.cacheDir, 'audio-16k.wav')

        if (!ctx.isCancelled() && isFresh(wav, ctx.sourcePath)) {
          ctx.report('Reusing the audio already extracted from this file', 100)
          return { wavPath: wav }
        }

        // ffmpeg is resolved the same way ffprobe is (tools/ first, then PATH),
        // so this machine and a fresh clone behave identically.
        const ffmpeg = findTool('ffmpeg') ?? 'ffmpeg'
        const duration = state.durationMs

        const result = await runProcess(
          ffmpeg,
          [
            '-hide_banner',
            '-nostdin',
            '-y',
            '-i',
            ctx.sourcePath,
            // Mono 16 kHz PCM is exactly what whisper.cpp wants, and doing the
            // conversion here means whisper never has to reason about containers
            // or sample rates. -vn drops the picture.
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            '-progress',
            'pipe:1',
            '-nostats',
            wav,
          ],
          {
            onSpawn: ctx.track,
            onStdout: (line) => {
              if (isFfmpegDone(line)) {
                ctx.report('Audio extracted', 100)
                return
              }
              const elapsed = parseFfmpegTime(line)
              if (elapsed === null) return
              // Without a duration there is no honest percentage, so we show the
              // elapsed time and let the bar advance only at the stage boundary.
              if (!duration || duration <= 0) {
                ctx.report(`Extracting audio — ${(elapsed / 1000).toFixed(0)}s so far`, null)
                return
              }
              ctx.report(
                `Extracting audio — ${(elapsed / 1000).toFixed(0)}s of ${(duration / 1000).toFixed(0)}s`,
                Math.min(99, (elapsed / duration) * 100),
              )
            },
          },
        )

        if (ctx.isCancelled()) throw new JobCancelled()
        if (result.code !== 0) {
          throw new TranscribeError(
            `ffmpeg could not extract the audio track (exit ${result.code}). ${lastLines(result.stderrTail)}`.trim(),
          )
        }
        if (!fs.existsSync(wav)) {
          throw new TranscribeError('ffmpeg reported success but wrote no audio file.')
        }
        return { wavPath: wav }
      },
    },

    {
      stage: 'transcribing',
      weight: 80,
      async run(state, ctx) {
        if (!state.wavPath) throw new TranscribeError('Internal error: no audio to transcribe.')
        fs.mkdirSync(ctx.cacheDir, { recursive: true })
        const prefix = path.join(ctx.cacheDir, 'transcript')

        const args = buildWhisperArgs({
          modelPath: ctx.model.absPath,
          wavPath: state.wavPath,
          prefix,
          language: ctx.language,
          dtw: ctx.dtw,
          threads: ctx.threads,
          vadPath: ctx.vadPath,
        })

        // A previous run may have left a JSON behind; if this run fails we must
        // never silently pick up the stale one.
        fs.rmSync(`${prefix}.json`, { force: true })

        const reported = new Set<number>()
        const onLine = (line: string) => {
          const percent = parseWhisperProgress(line)
          if (percent === null || reported.has(percent)) return
          reported.add(percent)
          ctx.report(`Transcribing — ${percent}%`, percent)
        }

        const result = await runProcess(ctx.cli, args, {
          onSpawn: ctx.track,
          onStdout: onLine,
          onStderr: onLine,
        })

        if (ctx.isCancelled()) throw new JobCancelled()
        if (result.code !== 0) {
          throw new TranscribeError(
            `whisper-cli failed (exit ${result.code}). ${lastLines(result.stderrTail)}`.trim(),
          )
        }

        const jsonPath = `${prefix}.json`
        if (!fs.existsSync(jsonPath)) {
          throw new TranscribeError(
            'whisper-cli exited cleanly but produced no JSON. Check the model file is complete — a truncated download still starts with the GGML magic.',
          )
        }
        return { jsonPath }
      },
    },

    {
      stage: 'assembling',
      weight: 5,
      async run(state, ctx) {
        if (!state.jsonPath) throw new TranscribeError('Internal error: no whisper output to read.')
        const json = parseWhisperJson(fs.readFileSync(state.jsonPath, 'utf8'))
        const { words, warnings, hasTokenTimings } = assembleWords(json, {
          ...DEFAULT_ASSEMBLE_OPTIONS,
          // Getting this wrong shifts every cue early by all the silence skipped
          // so far (§15.10). The JSON does not record whether --vad was used, so
          // the only honest source of truth is whether we passed it.
          vad: ctx.vadPath !== null,
        })
        warnings.forEach((warning) => ctx.warn(warning))

        if (!hasTokenTimings) {
          throw new TranscribeError(
            'whisper.cpp returned no per-token timings, so a word timeline cannot be built.',
          )
        }
        if (words.length === 0) {
          throw new TranscribeError(
            'No speech was recognised. If this file is not English, change the language; if it is mostly music or silence, there may be nothing to transcribe.',
          )
        }
        return { words, transcriptWarnings: warnings }
      },
    },

    {
      stage: 'segmenting',
      weight: 3,
      async run(state, ctx) {
        const { cues, warnings } = segmentWords(state.words)
        warnings.forEach((warning) => ctx.warn(warning))
        if (cues.length === 0) {
          throw new TranscribeError(
            'The word timeline produced no sentences, which should be impossible — please report it.',
          )
        }
        return { cues, transcriptWarnings: [...state.transcriptWarnings, ...warnings] }
      },
    },

    {
      stage: 'writing',
      weight: 2,
      async run(state, ctx) {
        const row = getLessonRow(ctx.lessonId)
        if (!row) throw new TranscribeError('The lesson disappeared from the library.')

        const existing = loadLesson(ctx.lessonId)
        if (!existing) throw new TranscribeError('lesson.json is unreadable, so it cannot be updated.')

        const lesson: Lesson = {
          ...existing,
          schemaVersion: SCHEMA_VERSION,
          transcript: {
            source: 'asr',
            engine: 'whisper.cpp',
            model: ctx.model.name,
            language: ctx.language,
            vad: ctx.vadPath !== null,
            wordTimestamps: true,
            segmentation: segmentationRecord(DEFAULT_SEGMENT_OPTIONS),
          },
          cues: state.cues as Cue[],
        }

        // lesson.json first, then the index: if the process dies between the two
        // the file is the fuller source of truth, and the row is rebuilt on the
        // next import. The other order would leave a row claiming lines that do
        // not exist.
        saveLesson(lesson)
        upsertLesson({
          id: row.id,
          sourcePath: row.source_path,
          sourceSize: row.source_size,
          sourceMtime: row.source_mtime,
          sourceDigest: row.source_digest,
          managed: row.managed === 1,
          title: row.title,
          durationMs: row.duration_ms,
          width: row.width,
          height: row.height,
          hasVideo: row.has_video === null ? null : row.has_video === 1,
          hasAudio: row.has_audio === null ? null : row.has_audio === 1,
          transcriptSource: 'asr',
          cueCount: state.cues.length,
        })
        return {}
      },
    },
  ]
}

// --- the public entry point --------------------------------------------------

export function startTranscription(options: StartOptions): StartResult {
  const row = getLessonRow(options.lessonId)
  if (!row) {
    return { ok: false, problem: { kind: 'no-such-lesson', message: 'No such lesson.' } }
  }

  const running = getActiveJobForLesson(options.lessonId)
  if (running) {
    return {
      ok: false,
      problem: {
        kind: 'already-running',
        message: `"${row.title}" is already being transcribed.`,
        jobId: running.id,
      },
    }
  }

  if (row.missing_since) {
    return {
      ok: false,
      problem: { kind: 'source-missing', message: `The source file is missing: ${row.source_path}` },
    }
  }
  if (row.has_audio === 0) {
    return { ok: false, problem: { kind: 'no-audio', message: 'This file has no audio track.' } }
  }
  if (row.cue_count > 0 && !options.force) {
    return {
      ok: false,
      problem: {
        kind: 'has-transcript',
        message: `"${row.title}" already has ${row.cue_count} lines. Re-transcribing would replace them and lose any edits.`,
        remedy: 'Re-transcribe to overwrite.',
      },
    }
  }

  const resolution = resolveAsrTools({ model: options.model })
  if (!resolution.ok) {
    return {
      ok: false,
      problem: {
        kind: 'toolchain',
        message: resolution.problem.message,
        remedy: resolution.problem.remedy,
      },
    }
  }

  const { cli, model, vad, notes } = resolution.tools
  const language = options.language ?? 'en'

  const runtime = makeRuntime({
    id: nextJobId(),
    lessonId: options.lessonId,
    title: row.title,
    stage: 'queued',
    percent: 0,
    detail: 'Starting',
    stagePercent: null,
    model: model.name,
    vad: vad !== null,
    cueCount: 0,
    warnings: [...notes],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    revision: 0,
  })
  registry().set(runtime.snapshot.id, runtime)
  prune()

  const context = makePipelineContext({
    lessonId: options.lessonId,
    sourcePath: row.source_path,
    model,
    dtw: model.dtw as string,
    cli,
    vadPath: vad,
    language,
    threads: Math.max(1, os.availableParallelism()),
    cacheDir: cacheDirFor(options.lessonId),
    warn: (message) => {
      if (!runtime.snapshot.warnings.includes(message)) {
        publishTo(runtime, { warnings: [...runtime.snapshot.warnings, message] })
      }
    },
    track: (child) => {
      runtime.child = child
      // A cancel that lands between `spawn` and this registration must still
      // kill the process, so re-check once it is tracked.
      if (runtime.cancelled) child.kill()
    },
    isCancelled: () => runtime.cancelled,
  })

  const steps = options.steps ?? makeDefaultSteps()

  // Deliberately not awaited: the HTTP route returns the job id immediately and
  // the client follows it over SSE.
  void executeJob(sinkFor(runtime), steps, context, { ...INITIAL_STATE, durationMs: row.duration_ms })
    .then((state) => {
      runtime.child = null
      publishTo(runtime, {
        stage: 'done',
        percent: 100,
        stagePercent: 100,
        detail: `${state.cues.length} lines`,
        cueCount: state.cues.length,
        finishedAt: new Date().toISOString(),
      })
    })
    .catch((error: unknown) => {
      runtime.child = null
      const cancelled = runtime.cancelled || error instanceof JobCancelled
      publishTo(runtime, {
        stage: cancelled ? 'cancelled' : 'failed',
        detail: cancelled ? 'Cancelled' : 'Failed',
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      })
    })

  return { ok: true, job: runtime.snapshot }
}
