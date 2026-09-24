/**
 * The transcription stage vocabulary.
 *
 * This lives in `lib/lesson` rather than in `lib/server/transcribe.ts` for one
 * specific reason: the UI needs it, and a *value* import from `lib/server/**`
 * into a client component drags the whole server graph into the browser bundle —
 * `transcribe.ts` → `repo.ts` → `db.ts` → `better-sqlite3` → `fs`, which the
 * browser cannot resolve. That failure reads as "Module not found: Can't resolve
 * 'fs'" and points at a SQLite binding, which is nowhere near the actual mistake.
 *
 * So this module has **no imports at all**: it is the shared vocabulary, and
 * `lib/server/transcribe.ts` uses it like any other consumer.
 */

export type TranscribeStage =
  | 'queued'
  | 'probing'
  | 'extracting'
  | 'transcribing'
  | 'assembling'
  | 'segmenting'
  | 'writing'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * One wording per stage, used by the executor, the CLI and the progress strip. A
 * second copy would drift and the same stage would end up with two names
 * depending on where you looked.
 */
export const STAGE_LABELS: Record<TranscribeStage, string> = {
  queued: 'Queued',
  probing: 'Reading the media',
  extracting: 'Extracting the audio track',
  transcribing: 'Transcribing',
  assembling: 'Building the word timeline',
  segmenting: 'Splitting into sentences',
  writing: 'Writing lesson.json',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** The three stages after which a job will never change again. */
export function isTerminalStage(stage: TranscribeStage): boolean {
  return stage === 'done' || stage === 'failed' || stage === 'cancelled'
}
