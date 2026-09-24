import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_TOOLS_DIR, loadConfig } from './config'

/**
 * Locating the ASR toolchain, and reading its progress off stderr.
 *
 * Pure Node: no `next/*` import, because `bin/transcribe.ts` drives this in a
 * plain Node process (same invariant as every other module in lib/server).
 *
 * The important design choice here is what this module does NOT contain: a list
 * of models. `scripts/install-tools.mjs` needs that list because it has to know
 * filenames and expected sizes to download; the runner must not, because a
 * duplicated table is a table that drifts — the installer gains a model and the
 * runner keeps insisting it does not exist. So the runner *looks at the disk*
 * and derives what it needs from the filename it finds.
 */

/** Where whisper.cpp keeps things once `npm run tools:install` has run. */
export const WHISPER_DIR_NAME = 'whisper'
export const MODELS_DIR_NAME = 'models'

/**
 * The `-dtw` value is not free-form: whisper-cli aborts on an unknown one. This
 * is the set whisper.cpp v1.7.x accepts, and it is the reason `deriveDtwName`
 * validates rather than trusting its own arithmetic — `distil-large-v3` derives
 * to `distil.large.v3`, which is not here, and quietly passing that to `-dtw`
 * would look like a model problem instead of a naming one.
 */
const DTW_NAMES = new Set([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large.v1',
  'large.v2',
  'large.v3',
  'large.v3.turbo',
])

/**
 * Silero VAD is a GGML file in the same directory as the speech models, so
 * filename shape is the only thing separating them.
 */
const VAD_FILE_PATTERN = /^ggml-silero-.*\.bin$/i

/** Per §15.10: measured unbiased and 15.7x real time, where turbo was 7x slower for no accuracy gain. */
export const DEFAULT_MODEL_NAME = 'base.en-q8_0'
export const VAD_FILE_NAME = 'ggml-silero-v5.1.2.bin'

export type StagedModel = {
  /** Filename stem without the `ggml-` prefix or the `.bin` suffix. */
  name: string
  file: string
  absPath: string
  sizeBytes: number
  /** Value to pass to `-dtw`, or null when whisper.cpp has no DTW table for it. */
  dtw: string | null
}

/**
 * `ggml-large-v3-turbo-q8_0.bin` -> `large.v3.turbo`
 *
 * The rule is forced by whisper.cpp's own naming: its DTW tables are dotted
 * (`large.v3.turbo`) while the weight files are dashed (`large-v3-turbo`), and
 * the quantisation suffix is not part of either. Returns null when the result is
 * not a DTW name whisper.cpp knows — callers must treat that as "cannot use word
 * timestamps", not as "try it anyway".
 */
export function deriveDtwName(modelName: string): string | null {
  const withoutQuant = modelName.replace(/-q\d+(?:_\d+)?$/i, '')
  if (!withoutQuant) return null
  const dotted = withoutQuant.replace(/-/g, '.')
  return DTW_NAMES.has(dotted) ? dotted : null
}

/** `ggml-base.en-q8_0.bin` -> `base.en-q8_0`, or null when this is not a speech model. */
export function modelNameFromFile(file: string): string | null {
  const base = path.basename(file)
  if (!base.toLowerCase().endsWith('.bin')) return null
  if (!/^ggml-/i.test(base)) return null
  if (VAD_FILE_PATTERN.test(base)) return null
  return base.slice('ggml-'.length, -'.bin'.length)
}

export function whisperToolchainDir(toolsDir?: string): string {
  const resolved = toolsDir ?? loadConfig().toolsDir ?? DEFAULT_TOOLS_DIR
  return path.join(resolved, WHISPER_DIR_NAME)
}

export function modelsDir(toolsDir?: string): string {
  return path.join(whisperToolchainDir(toolsDir), MODELS_DIR_NAME)
}

export function findWhisperCli(toolsDir?: string): string | null {
  const dir = whisperToolchainDir(toolsDir)
  const candidates = [
    path.join(dir, 'Release', 'whisper-cli.exe'),
    path.join(dir, 'whisper-cli.exe'),
    path.join(dir, 'Release', 'whisper-cli'),
    path.join(dir, 'whisper-cli'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/** Every staged speech model, largest last so the listing reads smallest-first. */
export function listStagedModels(toolsDir?: string): StagedModel[] {
  const dir = modelsDir(toolsDir)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const models: StagedModel[] = []
  for (const entry of entries) {
    const name = modelNameFromFile(entry)
    if (!name) continue
    const absPath = path.join(dir, entry)
    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(absPath).size
    } catch {
      continue
    }
    models.push({ name, file: entry, absPath, sizeBytes, dtw: deriveDtwName(name) })
  }
  return models.sort((a, b) => a.sizeBytes - b.sizeBytes)
}

export function findStagedModel(name: string, toolsDir?: string): StagedModel | null {
  return listStagedModels(toolsDir).find((model) => model.name === name) ?? null
}

export function findVadFile(toolsDir?: string): string | null {
  const dir = modelsDir(toolsDir)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  // Prefer the pinned version when several are staged, so a rerun is reproducible.
  const preferred = entries.find((entry) => entry === VAD_FILE_NAME)
  if (preferred) return path.join(dir, preferred)
  const any = entries.find((entry) => VAD_FILE_PATTERN.test(entry))
  return any ? path.join(dir, any) : null
}

export type ResolvedAsrTools = {
  cli: string
  model: StagedModel
  /** Null when Silero weights are missing; the caller then runs without `--vad`. */
  vad: string | null
  /** Human-readable reasons any optional part was dropped. */
  notes: string[]
}

export type AsrToolProblem = {
  /** `missing-cli` and `missing-model` are fatal; the UI treats them the same. */
  kind: 'missing-cli' | 'missing-model' | 'no-dtw'
  message: string
  /** The command that fixes it, printed verbatim by the CLI and shown in the UI. */
  remedy: string
}

export type AsrToolResolution =
  | { ok: true; tools: ResolvedAsrTools }
  | { ok: false; problem: AsrToolProblem }

/**
 * Everything a transcription run needs, or a precise account of what it lacks.
 *
 * Resolving the whole toolchain in one place (rather than letting the runner
 * discover a missing binary three stages in, after it has already extracted a
 * 40 MB wav) is what makes the failure cheap and the message specific.
 */
export function resolveAsrTools(
  options: { model?: string; toolsDir?: string; requireVad?: boolean } = {},
): AsrToolResolution {
  const notes: string[] = []
  const remedy = options.model
    ? `npm run tools:install -- --model ${options.model}`
    : 'npm run tools:install'

  const cli = findWhisperCli(options.toolsDir)
  if (!cli) {
    return {
      ok: false,
      problem: {
        kind: 'missing-cli',
        message: `whisper-cli was not found under tools/${WHISPER_DIR_NAME}. Transcription needs it.`,
        remedy,
      },
    }
  }

  const staged = listStagedModels(options.toolsDir)
  if (staged.length === 0) {
    return {
      ok: false,
      problem: {
        kind: 'missing-model',
        message: `No speech model is staged in tools/${WHISPER_DIR_NAME}/${MODELS_DIR_NAME}.`,
        remedy,
      },
    }
  }

  const wanted = options.model ?? DEFAULT_MODEL_NAME
  // An explicitly requested model that is absent is an error; the default
  // falling back to whatever IS staged is a convenience, and it is announced.
  const model = staged.find((candidate) => candidate.name === wanted) ?? null
  let chosen = model
  if (!chosen) {
    if (options.model) {
      return {
        ok: false,
        problem: {
          kind: 'missing-model',
          message: `Model "${wanted}" is not staged. Staged: ${staged.map((m) => m.name).join(', ')}.`,
          remedy,
        },
      }
    }
    chosen = staged[0]
    notes.push(`The default model ${wanted} is not staged; using ${chosen.name} instead.`)
  }

  if (!chosen.dtw) {
    return {
      ok: false,
      problem: {
        kind: 'no-dtw',
        message: `whisper.cpp has no DTW timing table for "${chosen.name}", so word-level timestamps are impossible. Use a model from the standard family (tiny/base/small/medium/large-v1/v2/v3/v3-turbo).`,
        remedy,
      },
    }
  }

  const vad = findVadFile(options.toolsDir)
  if (!vad) {
    notes.push(
      'Silero VAD weights are not staged, so this run cannot use --vad. Long silences may produce hallucinated lines.',
    )
  }

  return { ok: true, tools: { cli, model: chosen, vad, notes } }
}

// --- progress parsing --------------------------------------------------------

/**
 * whisper.cpp's progress callback line, e.g.
 *   `whisper_print_progress_callback: progress =  35%`
 *
 * Returns 0-100, or null for any other line. Progress is the only honest signal
 * the ASR stage can offer — it is by far the longest stage, and a spinner that
 * says nothing for two minutes is indistinguishable from a hang.
 */
export function parseWhisperProgress(line: string): number | null {
  // `\d+` rather than `\d{1,3}` on purpose: with a 3-digit cap, "1000%" would
  // match its last three digits and report 0%, so the range check below is what
  // actually rejects impossible values.
  const match = /progress\s*=\s*(\d+)\s*%/.exec(line)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) return null
  return value
}

/**
 * ffmpeg's `-progress` output, e.g. `out_time=00:01:23.456789`.
 *
 * Deliberately parses `out_time` and not `out_time_ms`: that key is named in
 * milliseconds and has always carried microseconds, and older builds differ on
 * top of that. `out_time` is a timestamp, so it means one thing.
 *
 * Returns milliseconds, or null for lines that are not a timestamp (ffmpeg emits
 * `out_time=N/A` before the first frame).
 */
export function parseFfmpegTime(line: string): number | null {
  const match = /^out_time=(\d+):(\d{2}):(\d{2})\.(\d{1,6})\s*$/.exec(line.trim())
  if (!match) return null
  const [, hours, minutes, seconds, fraction] = match
  // `.5` means half a second, not 5ms — pad the fraction to milliseconds.
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3))
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + millis
}

/** ffmpeg's terminal line, e.g. `progress=end`. */
export function isFfmpegDone(line: string): boolean {
  return line.trim() === 'progress=end'
}
