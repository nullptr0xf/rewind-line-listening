import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Path handling for the ingest pipeline.
 *
 * Hard rule of this project: everything downstream of the import step works on
 * an ABSOLUTE PATH. "Uploaded" files are materialised into the managed media
 * directory first, so that ffprobe / ffmpeg / whisper.cpp and the Range
 * streaming route all have exactly one kind of input to deal with.
 */

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.m4v',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
])

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.wav',
  '.ogg',
  '.opus',
  '.wma',
])

export const SUBTITLE_EXTENSIONS = ['.vtt', '.srt'] as const

export type PathProblem =
  | { kind: 'empty' }
  | { kind: 'not-found'; path: string }
  | { kind: 'not-a-file'; path: string }
  | { kind: 'not-readable'; path: string }
  | { kind: 'unsupported-extension'; ext: string }
  | { kind: 'outside-allowed-roots'; path: string; roots: string[] }

export type PathResolution =
  | { ok: true; absPath: string }
  | { ok: false; problem: PathProblem }

export function describeProblem(problem: PathProblem): string {
  switch (problem.kind) {
    case 'empty':
      return 'No path was given.'
    case 'not-found':
      return `File not found: ${problem.path}`
    case 'not-a-file':
      return `That path is a directory, not a file: ${problem.path}`
    case 'not-readable':
      return `Cannot read the file (permission denied or the file is locked by another program): ${problem.path}`
    case 'unsupported-extension':
      return `Unsupported container "${problem.ext}". Supported: video (${[...VIDEO_EXTENSIONS].join(' ')}), audio (${[...AUDIO_EXTENSIONS].join(' ')}).`
    case 'outside-allowed-roots':
      return `Path is outside the configured allowed roots: ${problem.path}`
  }
}

/**
 * Turn whatever the user pasted into a clean absolute path.
 *
 * Handles the shapes that actually show up on Windows:
 *   F:\videos\ep01.mp4
 *   "F:\my videos\ep 01.mp4"        <- Explorer "Copy as path"
 *   F:/videos/ep01.mp4
 *   file:///F:/videos/ep01.mp4
 *   %USERPROFILE%\Videos\ep01.mp4
 *   ~/Videos/ep01.mp4
 */
export function normalizeInputPath(raw: string): string {
  let value = (raw ?? '').trim()

  // Strip one layer of surrounding quotes, which "Copy as path" always adds.
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim()
    }
  }

  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
      // Windows file URLs look like /F:/videos/x.mp4
      if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1)
    } catch {
      value = value.replace(/^file:\/\//, '')
    }
  }

  // %VAR% expansion, then a leading ~
  value = value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()]
    return found ?? whole
  })
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(os.homedir(), value.slice(2))
  }

  return path.resolve(value)
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export type ValidateOptions = {
  allowedRoots?: string[]
  extensions?: Set<string>
}

export async function resolveSourcePath(
  raw: string,
  options: ValidateOptions = {},
): Promise<PathResolution> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, problem: { kind: 'empty' } }

  const absPath = normalizeInputPath(trimmed)

  const allowedRoots = (options.allowedRoots ?? []).filter(Boolean)
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => isInside(absPath, root))) {
    return { ok: false, problem: { kind: 'outside-allowed-roots', path: absPath, roots: allowedRoots } }
  }

  const allowed = options.extensions ?? new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])
  const ext = path.extname(absPath).toLowerCase()
  if (!allowed.has(ext)) {
    return { ok: false, problem: { kind: 'unsupported-extension', ext: ext || '(none)' } }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(absPath)
  } catch {
    return { ok: false, problem: { kind: 'not-found', path: absPath } }
  }
  if (!stat.isFile()) return { ok: false, problem: { kind: 'not-a-file', path: absPath } }

  try {
    await fs.access(absPath, fs.constants.R_OK)
  } catch {
    return { ok: false, problem: { kind: 'not-readable', path: absPath } }
  }

  return { ok: true, absPath }
}

const FINGERPRINT_CHUNK = 1024 * 1024

export type FileFingerprint = {
  size: number
  mtimeMs: number
  /** sha1 over size + first 1 MiB + last 1 MiB — stable across rename/move. */
  digest: string
  /** Short, user-visible identity of a lesson. */
  shortId: string
}

/**
 * Content fingerprint. Deliberately NOT a full-file hash:
 * a 2 GB movie would take seconds to hash completely, and we only need enough
 * entropy to recognise "the same file, possibly renamed or moved".
 */
export async function computeFingerprint(absPath: string): Promise<FileFingerprint> {
  const stat = await fs.stat(absPath)
  const size = stat.size
  const hash = crypto.createHash('sha1')
  hash.update(`size:${size};`)

  const handle = await fs.open(absPath, 'r')
  try {
    if (size <= FINGERPRINT_CHUNK * 2) {
      const whole = Buffer.alloc(Number(size))
      if (size > 0) await handle.read(whole, 0, Number(size), 0)
      hash.update(whole)
    } else {
      const head = Buffer.alloc(FINGERPRINT_CHUNK)
      await handle.read(head, 0, FINGERPRINT_CHUNK, 0)
      hash.update(head)

      const tail = Buffer.alloc(FINGERPRINT_CHUNK)
      await handle.read(tail, 0, FINGERPRINT_CHUNK, Number(size) - FINGERPRINT_CHUNK)
      hash.update(tail)
    }
  } finally {
    await handle.close()
  }

  const digest = hash.digest('hex')
  return { size, mtimeMs: Math.round(stat.mtimeMs), digest, shortId: digest.slice(0, 12) }
}

export function defaultTitle(absPath: string): string {
  const base = path.basename(absPath, path.extname(absPath))
  return base.replace(/[._]+/g, ' ').trim() || path.basename(absPath)
}
