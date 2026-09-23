import { z } from 'zod'

/**
 * lesson.json is the durable artefact of this app: one file per imported video.
 *
 * All timings are INTEGER MILLISECONDS. Mixing seconds and milliseconds is the
 * classic source of "two lines highlight at once" bugs at segment boundaries,
 * so the whole codebase speaks milliseconds and only formats to HH:MM:SS.mmm at
 * the edges (UI + export).
 */

export const SCHEMA_VERSION = 1

export const cueWordSchema = z.object({
  w: z.string(),
  s: z.number().int().nonnegative(),
  e: z.number().int().nonnegative(),
})

export const cueSchema = z.object({
  id: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
  words: z.array(cueWordSchema).nullable().default(null),
  translation: z.string().nullable().default(null),
  note: z.string().default(''),
  tags: z.array(z.string()).default([]),
  flags: z
    .object({
      edited: z.boolean().default(false),
      lowConfidence: z.boolean().default(false),
      ignored: z.boolean().default(false),
    })
    .default({ edited: false, lowConfidence: false, ignored: false }),
})

export const embeddedSubtitleSchema = z.object({
  streamIndex: z.number().int(),
  codec: z.string().nullable(),
  language: z.string().nullable(),
  title: z.string().nullable(),
})

export const lessonVideoSchema = z.object({
  /** Content fingerprint (size + head/tail hash). Stable across rename & move. */
  id: z.string(),
  path: z.string(),
  /** true when the file was copied into data/media instead of referenced in place. */
  managed: z.boolean().default(false),
  size: z.number().int(),
  mtime: z.number().int(),
  digest: z.string(),
  /** ISO timestamp when the source file could not be found; null when healthy. */
  missingSince: z.string().nullable().default(null),
  durationMs: z.number().int().nullable().default(null),
  width: z.number().int().nullable().default(null),
  height: z.number().int().nullable().default(null),
  hasVideo: z.boolean().nullable().default(null),
  hasAudio: z.boolean().nullable().default(null),
  audio: z
    .object({
      codec: z.string().nullable(),
      channels: z.number().int().nullable(),
      sampleRate: z.number().int().nullable(),
    })
    .nullable()
    .default(null),
  embeddedSubtitles: z.array(embeddedSubtitleSchema).default([]),
})

export const transcriptSourceSchema = z.enum([
  'manual-vtt',
  'sidecar-vtt',
  'sidecar-srt',
  'embedded-subtitle',
  'asr',
  'none',
])

export const lessonTranscriptSchema = z.object({
  source: transcriptSourceSchema,
  engine: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  language: z.string().nullable().default('en'),
  vad: z.boolean().nullable().default(null),
  wordTimestamps: z.boolean().nullable().default(null),
  segmentation: z
    .object({
      maxDurMs: z.number().int(),
      minDurMs: z.number().int(),
      gapMs: z.number().int(),
    })
    .nullable()
    .default(null),
})

export const lessonSchema = z.object({
  schemaVersion: z.number().int(),
  video: lessonVideoSchema,
  transcript: lessonTranscriptSchema,
  cues: z.array(cueSchema),
})

export type CueWord = z.infer<typeof cueWordSchema>
export type Cue = z.infer<typeof cueSchema>
export type EmbeddedSubtitle = z.infer<typeof embeddedSubtitleSchema>
export type LessonVideo = z.infer<typeof lessonVideoSchema>
export type LessonTranscript = z.infer<typeof lessonTranscriptSchema>
export type TranscriptSource = z.infer<typeof transcriptSourceSchema>
export type Lesson = z.infer<typeof lessonSchema>

export type LessonStatus = 'ready' | 'needs-transcription' | 'source-missing'

export function lessonStatus(lesson: Lesson): LessonStatus {
  if (lesson.video.missingSince) return 'source-missing'
  if (lesson.cues.length === 0) return 'needs-transcription'
  return 'ready'
}

export function emptyLesson(video: LessonVideo): Lesson {
  return {
    schemaVersion: SCHEMA_VERSION,
    video,
    transcript: {
      source: 'none',
      engine: null,
      model: null,
      language: 'en',
      vad: null,
      wordTimestamps: null,
      segmentation: null,
    },
    cues: [],
  }
}

/** Candidate for the 20-line hand-written fixture used to validate M0. */
export function makeCue(partial: Pick<Cue, 'id' | 'start' | 'end' | 'text'> & Partial<Cue>): Cue {
  return {
    words: null,
    translation: null,
    note: '',
    tags: [],
    flags: { edited: false, lowConfidence: false, ignored: false },
    ...partial,
  }
}
