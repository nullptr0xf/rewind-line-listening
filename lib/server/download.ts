import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { MANAGED_MEDIA_DIR, loadConfig, type LoadedConfig } from './config'
import { isInside, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from './path'
import { findTool } from './probe'
import { runProcess, lastLines } from './run-process'
import { ingestFile, type IngestReport, type IngestStage } from './ingest'
import {
  buildDownloadArgs,
  buildMetadataArgs,
  explainDownloadFailure,
  parseDestination,
  parseDownloadProgress,
  parseMetadata,
  probeTargetFor,
  resolveDownloadProxy,
  resolveDownloader,
  outputTemplate,
  type MediaChoice,
  type ResolvedDownloader,
  type VideoMetadata,
} from './download-tools'
import { DOWNLOAD_STAGE_LABELS, isDownloadFinished, type DownloadStage } from '../lesson/stages'

/**
 * The URL-download job runner: `url → downloader → ingestFile → library`.
 *
 * Same architecture as `lib/server/transcribe.ts`, on purpose, and for the same
 * four reasons: full snapshots rather than deltas, the toolchain resolved before
 * the first byte moves, an injected step list so the risky part is testable, and
 * a cancel that is distinct from a failure.
 *
 * ## The one decision worth reading
 *
 * A download is not a second ingest path. It ends by calling `ingestFile()` —
 * the same function the HTTP route, the native file picker and `bin/ingest.ts`
 * call. Invariant #1 in PROGRESS.md says there is exactly one of these, and the
 * payoff shows up immediately here: because the downloader writes its caption
 * track as `<id>.en.vtt` next to `<id>.m4a`, the *existing* sibling-subtitle
 * discovery picks it up with no new code at all, and the lesson is playable and
 * scrollable the moment it lands. The only thing this module adds is "produce a
 * file at a predictable absolute path".
 *
 * ## Why the downloaded file is 'managed'
 *
 * `managed: true` is what makes `removeLesson()` allowed to delete the media.
 * That is correct for a file this app created — the alternative is a library
 * that forgets a download and leaves it on disk forever. But it is only claimed
 * when the file actually landed inside the managed media directory, so pointing
 * `downloader.outputDir` at your own folder means the app will not touch it.
 *
 * Pure Node: no `next/*` import, because `bin/fetch.ts` drives this too.
 */

export type DownloadJob = {
  id: string
  url: string
  stage: DownloadStage
  /** 0-100 across the whole job. */
  percent: number
  detail: string
  stagePercent: number | null
  /** From the site, once `probing` has run. */
  title: string
  durationMs: number | null
  extractor: string | null
  /** Human-readable strings, straight from the downloader — no re-formatting. */
  totalText: string | null
  speed: string | null
  eta: string | null
  /** Everything below is filled in by the `importing` stage. */
  lessonId: string | null
  filePath: string | null
  cueCount: number | null
  transcriptSource: string | null
  warnings: string[]
  error: string | null
  /** The command that fixes a toolchain or proxy problem, when there is one. */
  remedy: string | null
  startedAt: string
  finishedAt: string | null
  revision: number
}

export type DownloadProblemKind =
  | 'bad-url'
  | 'already-running'
  | 'toolchain'
  | 'no-destination'

export type DownloadProblem = {
  kind: DownloadProblemKind
  message: string
  remedy?: string
  /** Set for `already-running`, so the UI can attach to the job already going. */
  jobId?: string
}

export type StartDownloadResult =
  | { ok: true; job: DownloadJob }
  | { ok: false; problem: DownloadProblem }

export type StartDownloadOptions = {
  url: string
  /** `audio` (default) or `video`. */
  mode?: 'audio' | 'video'
  maxHeight?: number
  /** Fetch the site's caption track as a `.vtt` sidecar. Default from config. */
  captions?: boolean
  /** Speech language for the caption track. */
  language?: string
  /** Override the configured output directory. */
  outputDir?: string
  /** Override the injected pipeline. Tests use this. */
  steps?: DownloadStep[]
  /** Override config and probing. Tests use these. */
  config?: LoadedConfig
}

// --- the job registry --------------------------------------------------------

type Listener = (job: DownloadJob) => void

export type JobRuntime = {
  snapshot: DownloadJob
  listeners: Set<Listener>
  child: ChildProcess | null
  cancelled: boolean
}

export type JobSink = {
  publish: (patch: Partial<DownloadJob>) => void
  isCancelled: () => boolean
}

const CACHE_KEY = Symbol.for('english-listening.download')

type GlobalWithJobs = typeof globalThis & { [CACHE_KEY]?: Map<string, JobRuntime> }

/**
 * Jobs live in memory, and only in memory — the durable result of a download is
 * the file on disk plus its library row, so there is nothing to resume after a
 * restart. Hangs off `globalThis` because Next.js re-evaluates modules on edit
 * in dev, and a job map that reset would orphan the SSE stream mid-download.
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
  const finished = [...jobs.values()].filter((runtime) => isDownloadFinished(runtime.snapshot.stage))
  if (finished.length <= MAX_FINISHED_JOBS) return
  finished
    .sort((a, b) => (a.snapshot.finishedAt ?? '').localeCompare(b.snapshot.finishedAt ?? ''))
    .slice(0, finished.length - MAX_FINISHED_JOBS)
    .forEach((runtime) => jobs.delete(runtime.snapshot.id))
}

let sequence = 0
function nextJobId(): string {
  sequence += 1
  return `dl_${Date.now().toString(36)}_${sequence.toString(36)}`
}

export function makeRuntime(snapshot: DownloadJob): JobRuntime {
  return { snapshot, listeners: new Set(), child: null, cancelled: false }
}

export function sinkFor(runtime: JobRuntime): JobSink {
  return {
    publish: (patch) => publishTo(runtime, patch),
    isCancelled: () => runtime.cancelled,
  }
}

export function publishTo(runtime: JobRuntime, patch: Partial<DownloadJob>): void {
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

export function getJob(jobId: string): DownloadJob | null {
  return registry().get(jobId)?.snapshot ?? null
}

export function listJobs(): DownloadJob[] {
  return [...registry().values()]
    .map((runtime) => runtime.snapshot)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** The job currently downloading this URL, if any — how the UI reattaches. */
export function getActiveJobForUrl(url: string): DownloadJob | null {
  const normalised = normaliseUrl(url)
  return (
    listJobs().find((job) => normaliseUrl(job.url) === normalised && !isDownloadFinished(job.stage)) ?? null
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

export function cancelJob(jobId: string): boolean {
  const runtime = registry().get(jobId)
  if (!runtime) return false
  if (isDownloadFinished(runtime.snapshot.stage)) return false
  runtime.cancelled = true
  // Killing the child is what actually stops the transfer. The flag alone would
  // let a 600 MB video keep arriving after the user pressed Stop.
  runtime.child?.kill()
  return true
}

// --- URL handling ------------------------------------------------------------

/**
 * A URL is normalised only for comparison, never for the request. That keeps
 * re-attach working when one caller passes `youtu.be/X` and another passes the
 * full `watch?v=X` form — a difference the user would read as a bug.
 */
export function normaliseUrl(raw: string): string {
  return raw.trim().toLowerCase()
}

export type UrlProblem = { message: string }

export function validateUrl(raw: string): UrlProblem | null {
  const value = (raw ?? '').trim()
  if (!value) return { message: 'Paste a video URL first.' }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { message: 'That is not a URL. It should start with http:// or https://' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { message: `"${parsed.protocol}" URLs are not supported — use http:// or https://` }
  }
  if (!parsed.hostname.includes('.')) {
    return { message: `"${parsed.hostname}" does not look like a site address.` }
  }
  return null
}

// --- the job context and steps ----------------------------------------------

export type DownloadContext = {
  jobId: string
  url: string
  downloader: ResolvedDownloader
  media: MediaChoice
  captions: boolean
  language: string
  destDir: string
  /** Absolute path to a staged ffmpeg, when one exists. Only used to merge. */
  ffmpegLocation: string | null
  config: LoadedConfig
  report: (detail: string, stagePercent?: number | null) => void
  /** Progress extras the downloader reported, merged into the job snapshot. */
  reportTransfer: (patch: Pick<DownloadJob, 'totalText' | 'speed' | 'eta'>) => void
  warn: (message: string) => void
  track: (child: ChildProcess) => void
  isCancelled: () => boolean
  /** Resolved in the `probing` step, then reused by `downloading`. */
  proxyUrl: string | null
}

export type DownloadState = {
  metadata: VideoMetadata | null
  /** Absolute path of the media file the downloader produced. */
  mediaPath: string | null
  /** Absolute path of the caption sidecar, when one was written. */
  captionPath: string | null
  ingest: IngestReport | null
}

export type DownloadStep = {
  stage: DownloadStage
  /** This stage's share of the progress bar. They deliberately sum to 100. */
  weight: number
  run: (state: DownloadState, ctx: DownloadContext) => Promise<Partial<DownloadState>>
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'JobCancelled'
  }
}

/** Thrown by a step for a condition that should reach the user verbatim. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

export const INITIAL_STATE: DownloadState = {
  metadata: null,
  mediaPath: null,
  captionPath: null,
  ingest: null,
}

/**
 * Drives the steps, owns the progress arithmetic, and guarantees what the UI
 * depends on: percentages never go backwards or exceed 100, and each stage's
 * full weight is spent even when the stage cannot measure itself.
 *
 * Exported for tests — the risky logic is the state machine, not the network.
 */
export async function executeJob(
  sink: JobSink,
  steps: DownloadStep[],
  ctx: DownloadContext,
  initial: DownloadState = INITIAL_STATE,
): Promise<DownloadState> {
  const total = steps.reduce((sum, step) => sum + step.weight, 0)
  if (total <= 0) throw new Error('executeJob needs at least one step with a positive weight.')

  let base = 0
  let span = total

  const context: DownloadContext = {
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

  for (const step of steps) {
    if (sink.isCancelled()) throw new JobCancelled()

    span = step.weight
    sink.publish({
      stage: step.stage,
      detail: DOWNLOAD_STAGE_LABELS[step.stage],
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

// --- file discovery ----------------------------------------------------------

const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])

/** Files youtube-dl leaves behind that are not the download. */
const NOT_MEDIA = /\.(part|ytdl|temp|vtt|srt|ass|json|description|info\.json)$/i

/**
 * Find what the downloader actually wrote.
 *
 * Globbing rather than predicting the extension: the format chain has fallbacks,
 * so a site offering only webm yields `.webm` where an m4a site yields `.m4a`,
 * and `--merge-output-format mp4` turns a two-stream download into `.mp4`. All
 * of those are correct outcomes; only one of them matches a hard-coded guess.
 */
export function findDownloadedMedia(destDir: string, id: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(destDir)
  } catch {
    return null
  }

  const matches = entries
    .filter((entry) => entry.startsWith(`${id}.`))
    .filter((entry) => !NOT_MEDIA.test(entry))
    .filter((entry) => MEDIA_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .map((entry) => path.join(destDir, entry))
    .filter((file) => {
      try {
        return fs.statSync(file).size > 0
      } catch {
        return false
      }
    })

  if (matches.length === 0) return null
  // A merge step can leave both the merged file and a source stream behind.
  // Prefer the one the user asked for: the merged/container output is the
  // largest, and a stray intermediate is always smaller than its result.
  return matches.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
}

/** The caption sidecar, matched by the same rule the ingest pipeline uses. */
export function findCaptionSidecar(destDir: string, id: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(destDir)
  } catch {
    return null
  }
  const match = entries.find(
    (entry) => entry.startsWith(`${id}.`) && /\.(vtt|srt)$/i.test(entry),
  )
  return match ? path.join(destDir, match) : null
}

/** A cancelled download leaves `<id>.<ext>.part`; it is ours, so it goes. */
export function cleanPartials(destDir: string, id: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(destDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${id}.`) || !/\.part$/i.test(entry)) continue
    try {
      fs.rmSync(path.join(destDir, entry), { force: true })
    } catch {
      /* best effort — a locked file is not worth failing a cancel over */
    }
  }
}

// --- the real pipeline -------------------------------------------------------

/** What each ingest sub-stage is called in a sentence a user reads. */
const INGEST_STAGE_WORDS: Record<IngestStage, string> = {
  resolving: 'Locating the file',
  fingerprinting: 'Fingerprinting it',
  probing: 'Probing the media',
  subtitle: 'Looking for subtitles',
  writing: 'Writing the lesson',
  done: 'Finishing',
}

export function makeDefaultSteps(): DownloadStep[] {
  return [
    {
      stage: 'probing',
      weight: 5,
      async run(_state, ctx) {
        // The proxy is decided here rather than at request time because the
        // health check is I/O: the HTTP route must answer immediately, and an
        // unusable proxy is a warning we can act on, not a refusal.
        //
        // The target is passed in so the check asks the real question — "can
        // this proxy reach the site I am about to fetch from?" — rather than
        // "is the port open?", which a proxy that refuses this host passes.
        const proxy = await resolveDownloadProxy({
          config: ctx.config,
          target: probeTargetFor(ctx.url),
        })
        if (proxy.warning) ctx.warn(proxy.warning)
        ctx.proxyUrl = proxy.url
        if (proxy.url) ctx.report(`Via the proxy at ${proxy.url}`, null)

        // `-J` prints the whole info dict on stdout, which for a site with many
        // formats runs to a few hundred kilobytes. Collected line by line
        // because that is how stdout arrives; joined back before parsing. The
        // cap is not a real-world concern — it is there so that a pathological
        // response cannot grow this array without bound.
        const stdoutLines: string[] = []

        const result = await runProcess(
          ctx.downloader.command,
          [...ctx.downloader.prefix, ...buildMetadataArgs({ url: ctx.url, proxyUrl: proxy.url })],
          {
            cwd: ctx.downloader.cwd ?? undefined,
            onSpawn: ctx.track,
            onStdout: (line) => {
              stdoutLines.push(line)
              if (stdoutLines.length > 4000) stdoutLines.shift()
            },
          },
        )

        if (ctx.isCancelled()) throw new JobCancelled()

        if (result.code !== 0) {
          throw new DownloadError(explainDownloadFailure(result.stderrTail))
        }

        const parsed = parseMetadata(stdoutLines.join('\n'))
        if (!parsed) {
          throw new DownloadError(
            'The site was read successfully but returned nothing this downloader understands.',
          )
        }
        return { metadata: parsed }
      },
    },

    {
      stage: 'downloading',
      weight: 90,
      async run(state, ctx) {
        const id = state.metadata?.id
        if (!id) throw new DownloadError('Internal error: no video id to download.')

        fs.mkdirSync(ctx.destDir, { recursive: true })

        let seenPercent = -1
        let destination: string | null = null

        const onLine = (line: string) => {
          const progress = parseDownloadProgress(line)
          if (progress) {
            // The terminal line carries no speed and no ETA, and carrying the
            // previous values forward would show a stale rate beside a
            // completed bar. `complete` is what tells the two apart.
            ctx.reportTransfer({
              totalText: progress.total,
              speed: progress.complete ? null : progress.speed,
              eta: progress.complete ? null : progress.eta,
            })
            if (progress.percent > seenPercent) {
              seenPercent = progress.percent
              // The percent belongs to the progress bar and its own column, not
              // to this sentence — repeating it here reads as a stutter in both
              // the web panel and the CLI.
              ctx.report(state.metadata?.title || 'Downloading', progress.percent)
            }
            return
          }
          const dest = parseDestination(line)
          if (dest) destination = dest
        }

        const args = [
          ...ctx.downloader.prefix,
          ...buildDownloadArgs({
            url: ctx.url,
            outputTemplate: outputTemplate(ctx.destDir, ctx.downloader.kind),
            proxyUrl: ctx.proxyUrl,
            media: ctx.media,
            captions: ctx.captions,
            language: ctx.language,
            ffmpegLocation: ctx.ffmpegLocation,
          }),
        ]

        const result = await runProcess(ctx.downloader.command, args, {
          cwd: ctx.downloader.cwd ?? undefined,
          onSpawn: ctx.track,
          onStdout: onLine,
          onStderr: onLine,
        })

        if (ctx.isCancelled()) {
          cleanPartials(ctx.destDir, id)
          throw new JobCancelled()
        }

        if (result.code !== 0) {
          cleanPartials(ctx.destDir, id)
          throw new DownloadError(explainDownloadFailure(result.stderrTail))
        }

        const mediaPath = findDownloadedMedia(ctx.destDir, id)
        if (!mediaPath) {
          throw new DownloadError(
            `The downloader reported success but no playable file appeared in ${ctx.destDir}.` +
              (destination ? ` It said it wrote ${destination}.` : '') +
              (result.stderrTail ? ` ${lastLines(result.stderrTail)}` : ''),
          )
        }
        return {
          mediaPath,
          captionPath: findCaptionSidecar(ctx.destDir, id),
        }
      },
    },

    {
      stage: 'importing',
      weight: 5,
      async run(state, ctx) {
        if (!state.mediaPath) throw new DownloadError('Internal error: nothing to import.')

        // The caption sidecar is not passed in. `ingestFile` discovers a
        // subtitle sitting next to the media by basename, which is exactly the
        // shape `<id>.en.vtt` + `<id>.m4a` has — so the download needs no
        // subtitle plumbing at all, and a hand-placed .srt keeps working
        // through the identical code path.
        const report = await ingestFile({
          path: state.mediaPath,
          title: state.metadata?.title,
          // Claim ownership only when the file is in our own directory. See the
          // note at the top of this module.
          managed: isInside(state.mediaPath, ctx.config.managedMediaDir || MANAGED_MEDIA_DIR),
          onProgress: (stage) => ctx.report(INGEST_STAGE_WORDS[stage], null),
        })

        report.warnings.forEach((warning) => ctx.warn(warning))
        if (state.captionPath) {
          ctx.report(`Captions found: ${path.basename(state.captionPath)}`, null)
        }
        return { ingest: report }
      },
    },
  ]
}

// --- the public entry point --------------------------------------------------

/**
 * The download-destination default. `data/media` is already the app's own
 * directory and already gitignored, so a "cache" of downloaded media is a
 * concept the project does not need a second time.
 */
export function resolveDestDir(options: { outputDir?: string; config: LoadedConfig }): string {
  return options.outputDir ?? options.config.downloader.outputDir ?? options.config.managedMediaDir
}

/**
 * Start a download job.
 *
 * Async because resolving the downloader means actually running an interpreter —
 * and it must be `spawn`, never `spawnSync`, which fails with `EBUSY` in this
 * project's environment (see `download-tools.ts`). Awaiting one probe (~200 ms)
 * before returning is what lets a missing toolchain come back as a 503 with a
 * command to run, instead of as a job that fails a second later after the user
 * has already navigated away.
 */
export async function startDownload(options: StartDownloadOptions): Promise<StartDownloadResult> {
  const config = options.config ?? loadConfig()

  const urlProblem = validateUrl(options.url)
  if (urlProblem) return { ok: false, problem: { kind: 'bad-url', message: urlProblem.message } }

  const running = getActiveJobForUrl(options.url)
  if (running) {
    return {
      ok: false,
      problem: {
        kind: 'already-running',
        message: 'This URL is already downloading.',
        jobId: running.id,
      },
    }
  }

  const resolution = await resolveDownloader({ config })
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

  const mode = options.mode ?? (config.downloader.audioOnly ? 'audio' : 'video')
  const destDir = resolveDestDir({ outputDir: options.outputDir, config })
  fs.mkdirSync(destDir, { recursive: true })

  const runtime = makeRuntime({
    id: nextJobId(),
    url: options.url.trim(),
    stage: 'queued',
    percent: 0,
    detail: 'Starting',
    stagePercent: null,
    title: '',
    durationMs: null,
    extractor: null,
    totalText: null,
    speed: null,
    eta: null,
    lessonId: null,
    filePath: null,
    cueCount: null,
    transcriptSource: null,
    warnings: [...resolution.notes],
    error: null,
    remedy: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    revision: 0,
  })
  registry().set(runtime.snapshot.id, runtime)
  prune()

  const context: DownloadContext = {
    jobId: runtime.snapshot.id,
    url: runtime.snapshot.url,
    downloader: resolution.downloader,
    media: { mode, maxHeight: options.maxHeight ?? config.downloader.maxHeight },
    captions: options.captions ?? config.downloader.captions,
    language: options.language ?? 'en',
    destDir,
    ffmpegLocation: findTool('ffmpeg'),
    config,
    proxyUrl: null,
    report: () => {},
    reportTransfer: (patch) => {
      // Publish only when something actually changed. youtube-dl emits a
      // progress line per fragment, and a snapshot per line would be thousands
      // of SSE frames that all say the same thing.
      const current = runtime.snapshot
      if (
        current.totalText === patch.totalText &&
        current.speed === patch.speed &&
        current.eta === patch.eta
      ) {
        return
      }
      publishTo(runtime, patch)
    },
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
  }

  // `report` is installed by executeJob, which owns the progress arithmetic.
  const steps = options.steps ?? makeDefaultSteps()

  // Deliberately not awaited: the HTTP route returns the job id immediately and
  // the client follows it over SSE.
  void executeJob(sinkFor(runtime), steps, context, INITIAL_STATE)
    .then((state) => {
      runtime.child = null
      const ingest = state.ingest
      publishTo(runtime, {
        stage: 'done',
        percent: 100,
        stagePercent: 100,
        detail: ingest
          ? ingest.cueCount > 0
            ? `${ingest.cueCount} lines from ${ingest.transcriptSource}`
            : 'Imported — no transcript yet'
          : 'Done',
        title: state.metadata?.title ?? runtime.snapshot.title,
        durationMs: state.metadata?.durationMs ?? null,
        extractor: state.metadata?.extractor ?? null,
        lessonId: ingest?.lessonId ?? null,
        filePath: state.mediaPath,
        cueCount: ingest?.cueCount ?? null,
        transcriptSource: ingest?.transcriptSource ?? null,
        finishedAt: new Date().toISOString(),
      })
    })
    .catch((error: unknown) => {
      runtime.child = null
      const cancelled = runtime.cancelled || error instanceof JobCancelled
      const message = error instanceof Error ? error.message : String(error)
      publishTo(runtime, {
        stage: cancelled ? 'cancelled' : 'failed',
        detail: cancelled ? 'Cancelled' : 'Failed',
        error: cancelled ? null : message,
        // A failure that names a command is a failure the user can act on.
        remedy: cancelled ? null : remedyFor(message),
        finishedAt: new Date().toISOString(),
      })
    })

  return { ok: true, job: runtime.snapshot }
}

/** Pull the actionable part out of a failure message, when there is one. */
function remedyFor(message: string): string | null {
  if (/downloader needs updating|No video formats/i.test(message)) {
    return 'npm run downloader:install -- --update'
  }
  if (/proxy/i.test(message)) {
    return 'Set downloader.proxy in ingest.config.json ("none" for a direct connection).'
  }
  return null
}
