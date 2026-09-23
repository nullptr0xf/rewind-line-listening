import fs from 'node:fs'
import path from 'node:path'
import {
  AUDIO_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  computeFingerprint,
  defaultTitle,
  describeProblem,
  resolveSourcePath,
} from './path'
import { loadConfig } from './config'
import { probeFile, type ProbeResult } from './probe'
import { getLessonRow, getLessonRowByDigest, saveLesson, upsertLesson } from './repo'
import { parseSubtitleText } from '../lesson/vtt'
import {
  SCHEMA_VERSION,
  emptyLesson,
  type Cue,
  type Lesson,
  type LessonVideo,
  type TranscriptSource,
} from '../lesson/schema'

/**
 * THE ingest pipeline. There is exactly one of these.
 *
 * Everything that can bring a video into the app — the HTTP route, the native
 * file picker, the CLI (`bin/ingest.ts`) — funnels through `ingestFile`. That is
 * the whole point of the design: three entry points, one code path, so their
 * behaviour can never drift apart.
 *
 * Constraints:
 *   - never import `next/*` here (the CLI runs this in a plain Node process)
 *   - never modify or delete the user's source file
 */

export class IngestError extends Error {
  readonly code: string
  constructor(message: string, code = 'ingest-failed') {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

export type IngestOptions = {
  /** Raw path as typed / pasted / returned by the file picker. */
  path: string
  title?: string
  /** Explicit external subtitle file. */
  subtitlePath?: string
  /** Inline subtitle payload (used by the test fixtures and the CLI). */
  subtitleText?: string
  /** Re-ingest even when the content fingerprint is already known. */
  force?: boolean
  /** True when the caller already copied the file into the managed media dir. */
  managed?: boolean
  /** Keep loud progress output out of the HTTP path; the CLI turns it on. */
  onProgress?: (stage: IngestStage, detail?: string) => void
}

export type IngestStage =
  | 'resolving'
  | 'fingerprinting'
  | 'probing'
  | 'subtitle'
  | 'writing'
  | 'done'

export type IngestReport = {
  lessonId: string
  created: boolean
  reused: boolean
  title: string
  absPath: string
  cueCount: number
  transcriptSource: TranscriptSource
  /** Where the transcript came from, when it came from a file on disk. */
  transcriptPath: string | null
  warnings: string[]
  probe: {
    available: boolean
    error: string | null
    durationMs: number | null
    hasAudio: boolean
    embeddedSubtitleCount: number
  }
}

function subtitleSourceFor(extension: string): TranscriptSource {
  return extension.toLowerCase() === '.srt' ? 'sidecar-srt' : 'sidecar-vtt'
}

/**
 * Look for a subtitle file sitting next to the video, matching by basename.
 * "ep01.mkv" matches "ep01.en.srt", "ep01.srt" and "ep01.whatever.vtt".
 */
export function findSiblingSubtitle(absPath: string): string | null {
  const dir = path.dirname(absPath)
  const base = path.basename(absPath, path.extname(absPath)).toLowerCase()

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }

  const candidates = entries
    .filter((entry) => SUBTITLE_EXTENSIONS.includes(path.extname(entry).toLowerCase() as never))
    .map((entry) => ({ entry, stem: path.basename(entry, path.extname(entry)).toLowerCase() }))
    .filter(({ stem }) => stem === base || stem.startsWith(base))
    .sort((a, b) => {
      // Prefer an exact basename match, then .vtt over .srt, then shortest name.
      const exactA = a.stem === base ? 0 : 1
      const exactB = b.stem === base ? 0 : 1
      if (exactA !== exactB) return exactA - exactB
      const vttA = path.extname(a.entry).toLowerCase() === '.vtt' ? 0 : 1
      const vttB = path.extname(b.entry).toLowerCase() === '.vtt' ? 0 : 1
      if (vttA !== vttB) return vttA - vttB
      return a.entry.length - b.entry.length
    })

  if (candidates.length === 0) {
    // A .ass file next to the video is worth telling the user about, since we
    // cannot parse it yet.
    const ass = entries.find(
      (entry) =>
        path.basename(entry, path.extname(entry)).toLowerCase().startsWith(base) &&
        path.extname(entry).toLowerCase() === '.ass',
    )
    if (ass) return path.join(dir, ass)
    return null
  }

  return path.join(dir, candidates[0].entry)
}

function readSubtitle(filePath: string): { cues: Cue[]; source: TranscriptSource; warnings: string[] } {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.ass') {
    throw new IngestError(
      `Found an .ass subtitle next to the video, but .ass is not supported yet. Convert it first, e.g.: ffmpeg -i "in.ass" "out.vtt"`,
      'unsupported-subtitle',
    )
  }
  const text = fs.readFileSync(filePath, 'utf8')
  const { cues, report } = parseSubtitleText(text)
  return { cues, source: subtitleSourceFor(extension), warnings: report.warnings }
}

function buildVideo(
  id: string,
  absPath: string,
  fingerprint: Awaited<ReturnType<typeof computeFingerprint>>,
  managed: boolean,
  probe: ProbeResult,
  previousMissing: string | null,
): LessonVideo {
  return {
    id,
    path: absPath,
    managed,
    size: fingerprint.size,
    mtime: fingerprint.mtimeMs,
    digest: fingerprint.digest,
    missingSince: previousMissing,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    hasVideo: probe.available ? probe.hasVideo : null,
    hasAudio: probe.available ? probe.hasAudio : null,
    audio: probe.audio,
    embeddedSubtitles: probe.embeddedSubtitles,
  }
}

export async function ingestFile(options: IngestOptions): Promise<IngestReport> {
  const notify = options.onProgress ?? (() => {})
  const config = loadConfig()
  const warnings: string[] = []

  notify('resolving')
  const resolution = await resolveSourcePath(options.path, {
    allowedRoots: config.allowedRoots,
    extensions: new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]),
  })
  if (!resolution.ok) {
    throw new IngestError(describeProblem(resolution.problem), resolution.problem.kind)
  }
  const absPath = resolution.absPath

  notify('fingerprinting')
  const fingerprint = await computeFingerprint(absPath)

  const existingByDigest = getLessonRowByDigest(fingerprint.digest)
  if (existingByDigest && !options.force) {
    // Same bytes: this is a re-import, not a new lesson. Renaming or moving the
    // file therefore does NOT fork the library, it just re-points the row.
    const moved = existingByDigest.source_path !== absPath
    if (moved) {
      upsertLesson({
        id: existingByDigest.id,
        sourcePath: absPath,
        sourceSize: fingerprint.size,
        sourceMtime: fingerprint.mtimeMs,
        sourceDigest: fingerprint.digest,
        managed: options.managed ?? existingByDigest.managed === 1,
        title: options.title ?? existingByDigest.title,
        durationMs: existingByDigest.duration_ms,
        width: existingByDigest.width,
        height: existingByDigest.height,
        hasVideo: existingByDigest.has_video === null ? null : existingByDigest.has_video === 1,
        hasAudio: existingByDigest.has_audio === null ? null : existingByDigest.has_audio === 1,
        transcriptSource: existingByDigest.transcript_source,
        cueCount: existingByDigest.cue_count,
      })
      warnings.push(`This file was already imported from ${existingByDigest.source_path}; re-pointed to the new location.`)
    }

    notify('done')
    return {
      lessonId: existingByDigest.id,
      created: false,
      reused: true,
      title: options.title ?? existingByDigest.title,
      absPath,
      cueCount: existingByDigest.cue_count,
      transcriptSource: existingByDigest.transcript_source as TranscriptSource,
      transcriptPath: null,
      warnings,
      probe: {
        available: false,
        error: null,
        durationMs: existingByDigest.duration_ms,
        hasAudio: existingByDigest.has_audio === 1,
        embeddedSubtitleCount: 0,
      },
    }
  }

  const previousRow = existingByDigest ?? getLessonRow(fingerprint.shortId)

  notify('probing')
  const probe = await probeFile(absPath)
  if (!probe.available && probe.error) warnings.push(probe.error)
  if (probe.available && !probe.hasAudio) {
    warnings.push('No audio track was found in this file — transcription will not be possible.')
  }

  notify('subtitle')
  let cues: Cue[] = []
  let transcriptSource: TranscriptSource = 'none'
  let transcriptPath: string | null = null
  let engine: string | null = null
  let model: string | null = null

  if (options.subtitleText) {
    const { cues: parsed, report } = parseSubtitleText(options.subtitleText)
    cues = parsed
    transcriptSource = 'manual-vtt'
    engine = 'inline'
    warnings.push(...report.warnings)
  } else {
    const explicit = options.subtitlePath
      ? path.resolve(options.subtitlePath)
      : findSiblingSubtitle(absPath)

    if (explicit && fs.existsSync(explicit)) {
      const result = readSubtitle(explicit)
      cues = result.cues
      transcriptSource = result.source
      transcriptPath = explicit
      engine = path.basename(explicit)
      warnings.push(...result.warnings)
    } else if (probe.embeddedSubtitles.length > 0) {
      warnings.push(
        `This file has ${probe.embeddedSubtitles.length} embedded subtitle stream(s), but extraction is part of M1. No transcript loaded yet.`,
      )
    }
  }

  notify('writing')
  const video = buildVideo(
    fingerprint.shortId,
    absPath,
    fingerprint,
    options.managed ?? false,
    probe,
    previousRow?.missing_since ?? null,
  )

  const lesson: Lesson = {
    ...emptyLesson(video),
    schemaVersion: SCHEMA_VERSION,
    transcript: {
      source: transcriptSource,
      engine,
      model,
      language: 'en',
      vad: null,
      wordTimestamps: null,
      segmentation: null,
    },
    cues,
  }

  saveLesson(lesson)
  upsertLesson({
    id: lesson.video.id,
    sourcePath: absPath,
    sourceSize: fingerprint.size,
    sourceMtime: fingerprint.mtimeMs,
    sourceDigest: fingerprint.digest,
    managed: lesson.video.managed,
    title: options.title?.trim() || previousRow?.title || defaultTitle(absPath),
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    hasVideo: probe.available ? probe.hasVideo : null,
    hasAudio: probe.available ? probe.hasAudio : null,
    transcriptSource,
    cueCount: cues.length,
  })

  notify('done')

  return {
    lessonId: lesson.video.id,
    created: !previousRow,
    reused: false,
    title: options.title?.trim() || defaultTitle(absPath),
    absPath,
    cueCount: cues.length,
    transcriptSource,
    transcriptPath,
    warnings,
    probe: {
      available: probe.available,
      error: probe.error,
      durationMs: probe.durationMs,
      hasAudio: probe.hasAudio,
      embeddedSubtitleCount: probe.embeddedSubtitles.length,
    },
  }
}

export type { ProbeResult }
