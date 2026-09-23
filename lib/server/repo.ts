import fs from 'node:fs'
import path from 'node:path'
import { LESSONS_DIR, ensureDataDirs } from './config'
import { getDb, type LessonRow } from './db'
import { lessonSchema, type Lesson } from '../lesson/schema'

/**
 * Storage layer. Two tiers, on purpose:
 *   data/lessons/<id>/lesson.json  -> the transcript document (readable, diffable)
 *   data/app.db                    -> the queryable index + app state
 *
 * This module never deletes a user's source video. Removing a lesson only drops
 * our own rows and, at most, a file we copied into data/media ourselves.
 */

export function lessonDir(id: string): string {
  return path.join(LESSONS_DIR, id)
}

export function lessonJsonPath(id: string): string {
  return path.join(lessonDir(id), 'lesson.json')
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, filePath)
}

export function saveLesson(lesson: Lesson): void {
  writeJsonAtomic(lessonJsonPath(lesson.video.id), lesson)
}

export function loadLesson(id: string): Lesson | null {
  const filePath = lessonJsonPath(id)
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const result = lessonSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(`[repo] lesson.json failed validation for ${id}: ${result.error.message}`)
      return null
    }
    return result.data as Lesson
  } catch (error) {
    console.warn(`[repo] could not read lesson.json for ${id}: ${String(error)}`)
    return null
  }
}

export type LessonSummary = {
  id: string
  title: string
  sourcePath: string
  managed: boolean
  sizeBytes: number
  durationMs: number | null
  width: number | null
  height: number | null
  cueCount: number
  transcriptSource: string
  missingSince: string | null
  lastPositionMs: number
  addedAt: string
  updatedAt: string
}

export function toSummary(row: LessonRow): LessonSummary {
  return {
    id: row.id,
    title: row.title,
    sourcePath: row.source_path,
    managed: row.managed === 1,
    sizeBytes: row.source_size,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    cueCount: row.cue_count,
    transcriptSource: row.transcript_source,
    missingSince: row.missing_since,
    lastPositionMs: row.last_position_ms,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  }
}

export function listLessonRows(): LessonRow[] {
  return getDb()
    .prepare<[], LessonRow>('SELECT * FROM lessons ORDER BY added_at DESC')
    .all()
}

export function listLessons(): LessonSummary[] {
  return listLessonRows().map(toSummary)
}

export function getLessonRow(id: string): LessonRow | null {
  return (
    getDb().prepare<[string], LessonRow>('SELECT * FROM lessons WHERE id = ?').get(id) ?? null
  )
}

export function getLessonRowByDigest(digest: string): LessonRow | null {
  return (
    getDb()
      .prepare<[string], LessonRow>('SELECT * FROM lessons WHERE source_digest = ?')
      .get(digest) ?? null
  )
}

export type UpsertLessonInput = {
  id: string
  sourcePath: string
  sourceSize: number
  sourceMtime: number
  sourceDigest: string
  managed: boolean
  title: string
  durationMs: number | null
  width: number | null
  height: number | null
  hasVideo: boolean | null
  hasAudio: boolean | null
  transcriptSource: string
  cueCount: number
}

export function upsertLesson(input: UpsertLessonInput): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO lessons (
         id, source_path, source_size, source_mtime, source_digest, managed, missing_since,
         title, duration_ms, width, height, has_video, has_audio,
         transcript_source, cue_count, added_at, updated_at
       ) VALUES (
         @id, @sourcePath, @sourceSize, @sourceMtime, @sourceDigest, @managed, NULL,
         @title, @durationMs, @width, @height, @hasVideo, @hasAudio,
         @transcriptSource, @cueCount, @now, @now
       )
       ON CONFLICT(id) DO UPDATE SET
         source_path       = excluded.source_path,
         source_size       = excluded.source_size,
         source_mtime      = excluded.source_mtime,
         source_digest     = excluded.source_digest,
         managed           = excluded.managed,
         missing_since     = NULL,
         title             = excluded.title,
         duration_ms       = COALESCE(excluded.duration_ms, lessons.duration_ms),
         width             = COALESCE(excluded.width, lessons.width),
         height            = COALESCE(excluded.height, lessons.height),
         has_video         = COALESCE(excluded.has_video, lessons.has_video),
         has_audio         = COALESCE(excluded.has_audio, lessons.has_audio),
         transcript_source = excluded.transcript_source,
         cue_count         = excluded.cue_count,
         updated_at        = excluded.updated_at`,
    )
    .run({
      id: input.id,
      sourcePath: input.sourcePath,
      sourceSize: input.sourceSize,
      sourceMtime: input.sourceMtime,
      sourceDigest: input.sourceDigest,
      managed: input.managed ? 1 : 0,
      title: input.title,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
      hasVideo: input.hasVideo === null ? null : input.hasVideo ? 1 : 0,
      hasAudio: input.hasAudio === null ? null : input.hasAudio ? 1 : 0,
      transcriptSource: input.transcriptSource,
      cueCount: input.cueCount,
      now,
    })
}

export function markSourceMissing(id: string, missingSince: string | null): void {
  getDb()
    .prepare('UPDATE lessons SET missing_since = ?, updated_at = ? WHERE id = ?')
    .run(missingSince, new Date().toISOString(), id)
}

export function setTitle(id: string, title: string): void {
  getDb()
    .prepare('UPDATE lessons SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, new Date().toISOString(), id)
}

export function setLastPosition(id: string, positionMs: number): void {
  getDb()
    .prepare('UPDATE lessons SET last_position_ms = ? WHERE id = ?')
    .run(Math.max(0, Math.round(positionMs)), id)
}

export function setDuration(id: string, durationMs: number, width?: number, height?: number): void {
  getDb()
    .prepare(
      `UPDATE lessons
         SET duration_ms = COALESCE(duration_ms, @durationMs),
             width       = COALESCE(width, @width),
             height      = COALESCE(height, @height)
       WHERE id = @id`,
    )
    .run({
      id,
      durationMs: Math.round(durationMs),
      width: width ?? null,
      height: height ?? null,
    })
}

export type RemoveOptions = {
  /** Only ever true for media we copied into data/media ourselves. */
  deleteManagedFile?: boolean
}

export function removeLesson(id: string, options: RemoveOptions = {}): void {
  const row = getLessonRow(id)
  if (!row) return

  if (options.deleteManagedFile && row.managed === 1) {
    try {
      fs.rmSync(row.source_path, { force: true })
    } catch (error) {
      console.warn(`[repo] could not delete managed media ${row.source_path}: ${String(error)}`)
    }
  }
  // The source file is otherwise left completely untouched.

  try {
    fs.rmSync(lessonDir(id), { recursive: true, force: true })
  } catch (error) {
    console.warn(`[repo] could not delete lesson dir for ${id}: ${String(error)}`)
  }

  getDb().prepare('DELETE FROM lessons WHERE id = ?').run(id)
}

export function ensureStorage(): void {
  ensureDataDirs()
}
