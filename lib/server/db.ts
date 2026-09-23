import Database from 'better-sqlite3'
import { DB_PATH, ensureDataDirs } from './config'

/**
 * SQLite holds the library index and app state (progress, and later favourites).
 * The transcript itself lives in lesson.json on disk — a document you can read,
 * diff and hand-edit — while SQLite handles the queries JSON is bad at.
 */

export type LessonRow = {
  id: string
  source_path: string
  source_size: number
  source_mtime: number
  source_digest: string
  managed: number
  missing_since: string | null
  title: string
  duration_ms: number | null
  width: number | null
  height: number | null
  has_video: number | null
  has_audio: number | null
  transcript_source: string
  cue_count: number
  last_position_ms: number
  added_at: string
  updated_at: string
}

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS lessons (
  id                TEXT PRIMARY KEY,
  source_path       TEXT NOT NULL,
  source_size       INTEGER NOT NULL,
  source_mtime      INTEGER NOT NULL,
  source_digest     TEXT NOT NULL,
  managed           INTEGER NOT NULL DEFAULT 0,
  missing_since     TEXT,
  title             TEXT NOT NULL,
  duration_ms       INTEGER,
  width             INTEGER,
  height            INTEGER,
  has_video         INTEGER,
  has_audio         INTEGER,
  transcript_source TEXT NOT NULL DEFAULT 'none',
  cue_count         INTEGER NOT NULL DEFAULT 0,
  last_position_ms  INTEGER NOT NULL DEFAULT 0,
  added_at          TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lessons_digest_idx ON lessons (source_digest);
CREATE INDEX IF NOT EXISTS lessons_added_idx ON lessons (added_at DESC);
`

const MIGRATIONS: string[] = [MIGRATION_1]

const CACHE_KEY = Symbol.for('english-listening.db')

type GlobalWithDb = typeof globalThis & { [CACHE_KEY]?: Database.Database }

export function getDb(): Database.Database {
  const container = globalThis as GlobalWithDb
  const cached = container[CACHE_KEY]
  if (cached) return cached

  ensureDataDirs()
  const instance = new Database(DB_PATH)
  instance.pragma('journal_mode = WAL')
  instance.pragma('synchronous = NORMAL')

  const current = instance.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    instance.exec(MIGRATIONS[version])
    instance.pragma(`user_version = ${version + 1}`)
  }

  container[CACHE_KEY] = instance
  return instance
}
