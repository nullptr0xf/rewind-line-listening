import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_NAME,
  deriveDtwName,
  findVadFile,
  isFfmpegDone,
  listStagedModels,
  modelNameFromFile,
  parseFfmpegTime,
  parseWhisperProgress,
  resolveAsrTools,
  VAD_FILE_NAME,
} from './asr'

/**
 * These tests exist because everything here is a place where a plausible-looking
 * value is wrong. `-dtw` takes a dotted name while the weight files are dashed;
 * ffmpeg's `out_time_ms` is named in milliseconds and carries microseconds; and a
 * `-dtw` value whisper.cpp does not recognise fails deep inside the engine with
 * an error that reads like a corrupt model.
 */

describe('deriveDtwName', () => {
  it('strips the quantisation suffix and converts dashes to dots', () => {
    // The transcription of whisper.cpp's own naming: files are dashed, DTW tables are dotted.
    expect(deriveDtwName('base.en-q8_0')).toBe('base.en')
    expect(deriveDtwName('large-v3-turbo-q8_0')).toBe('large.v3.turbo')
    expect(deriveDtwName('medium.en-q5_0')).toBe('medium.en')
    expect(deriveDtwName('small.en-q5_1')).toBe('small.en')
    expect(deriveDtwName('large-v3-q5_0')).toBe('large.v3')
  })

  it('accepts unquantised names', () => {
    expect(deriveDtwName('tiny.en')).toBe('tiny.en')
    expect(deriveDtwName('base')).toBe('base')
  })

  it('returns null for names whisper.cpp has no DTW table for', () => {
    // This is the case that justifies validating instead of trusting the
    // arithmetic: the derivation "succeeds" and produces a name that is not real.
    expect(deriveDtwName('distil-large-v3-q5_0')).toBeNull()
    expect(deriveDtwName('large-v3-turbo')).toBe('large.v3.turbo')
    expect(deriveDtwName('whisper-nonsense')).toBeNull()
    expect(deriveDtwName('')).toBeNull()
  })
})

describe('modelNameFromFile', () => {
  it('strips the ggml prefix and the extension', () => {
    expect(modelNameFromFile('ggml-base.en-q8_0.bin')).toBe('base.en-q8_0')
    expect(modelNameFromFile('ggml-large-v3-turbo-q8_0.bin')).toBe('large-v3-turbo-q8_0')
  })

  it('rejects the Silero VAD weights, which live in the same directory', () => {
    expect(modelNameFromFile('ggml-silero-v5.1.2.bin')).toBeNull()
  })

  it('rejects files that are not whisper weights at all', () => {
    expect(modelNameFromFile('base.en-q8_0.bin')).toBeNull()
    expect(modelNameFromFile('ggml-base.en-q8_0.txt')).toBeNull()
    expect(modelNameFromFile('README.md')).toBeNull()
  })
})

describe('parseWhisperProgress', () => {
  it('reads the progress callback line', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  35%')).toBe(35)
    expect(parseWhisperProgress('whisper_print_progress_callback: progress = 100%')).toBe(100)
    expect(parseWhisperProgress('progress = 0%')).toBe(0)
  })

  it('rejects impossible percentages rather than truncating them', () => {
    // With a `\d{1,3}` pattern this would match "000" and report a confident 0%.
    expect(parseWhisperProgress('progress = 1000%')).toBeNull()
  })

  it('ignores every other line whisper.cpp prints', () => {
    expect(parseWhisperProgress('whisper_print_timings:     load time =   412.58 ms')).toBeNull()
    expect(parseWhisperProgress('[00:00:00.000 --> 00:00:04.000]  Hello')).toBeNull()
    expect(parseWhisperProgress('')).toBeNull()
  })
})

describe('parseFfmpegTime', () => {
  it('reads the out_time timestamp', () => {
    expect(parseFfmpegTime('out_time=00:00:00.000000')).toBe(0)
    expect(parseFfmpegTime('out_time=00:01:23.456789')).toBe(83_456)
    expect(parseFfmpegTime('out_time=01:00:00.000000')).toBe(3_600_000)
  })

  it('treats a short fraction as a fraction, not as milliseconds', () => {
    // ".5" is half a second. Reading it as 5ms would make the progress bar lurch.
    expect(parseFfmpegTime('out_time=00:00:01.5')).toBe(1500)
    expect(parseFfmpegTime('out_time=00:00:01.05')).toBe(1050)
  })

  it('ignores lines that are not a timestamp', () => {
    // ffmpeg emits N/A until the first frame is written.
    expect(parseFfmpegTime('out_time=N/A')).toBeNull()
    expect(parseFfmpegTime('out_time_ms=0')).toBeNull()
    expect(parseFfmpegTime('progress=continue')).toBeNull()
    expect(parseFfmpegTime('')).toBeNull()
  })
})

describe('isFfmpegDone', () => {
  it('recognises the terminal line and tolerates whitespace', () => {
    expect(isFfmpegDone('progress=end')).toBe(true)
    expect(isFfmpegDone('progress=end\r')).toBe(true)
    expect(isFfmpegDone('progress=continue')).toBe(false)
  })
})

/** A throwaway tools tree, so these tests never depend on what is installed. */
function makeToolsDir(structure: { cli?: boolean; models?: string[] }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-tools-'))
  const whisper = path.join(root, 'whisper')
  const models = path.join(whisper, 'models')
  fs.mkdirSync(models, { recursive: true })
  if (structure.cli) {
    fs.mkdirSync(path.join(whisper, 'Release'), { recursive: true })
    fs.writeFileSync(path.join(whisper, 'Release', 'whisper-cli.exe'), 'stub')
  }
  for (const file of structure.models ?? []) {
    fs.writeFileSync(path.join(models, file), Buffer.alloc(1024))
  }
  return root
}

const created: string[] = []
function toolsDir(structure: Parameters<typeof makeToolsDir>[0]): string {
  const dir = makeToolsDir(structure)
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

describe('listStagedModels', () => {
  it('finds speech models, skips the VAD weights, and sorts smallest first', () => {
    const dir = toolsDir({
      models: ['ggml-large-v3-turbo-q8_0.bin', 'ggml-base.en-q8_0.bin', 'ggml-silero-v5.1.2.bin'],
    })
    const models = listStagedModels(dir)
    expect(models.map((m) => m.name)).toEqual(['base.en-q8_0', 'large-v3-turbo-q8_0'])
    expect(models[0].dtw).toBe('base.en')
    expect(models[1].dtw).toBe('large.v3.turbo')
  })

  it('returns an empty list when nothing is staged, rather than throwing', () => {
    expect(listStagedModels(toolsDir({}))).toEqual([])
    expect(listStagedModels('Z:/definitely/not/here')).toEqual([])
  })
})

describe('findVadFile', () => {
  it('prefers the pinned version when several are present', () => {
    const dir = toolsDir({ models: ['ggml-silero-v5.1.2-extra.bin', VAD_FILE_NAME] })
    expect(findVadFile(dir)).toBe(path.join(dir, 'whisper', 'models', VAD_FILE_NAME))
  })

  it('accepts any silero build when the pinned one is absent', () => {
    const dir = toolsDir({ models: ['ggml-silero-v9.9.9.bin'] })
    expect(path.basename(findVadFile(dir) ?? '')).toBe('ggml-silero-v9.9.9.bin')
  })

  it('returns null when there are none', () => {
    expect(findVadFile(toolsDir({ models: ['ggml-base.en-q8_0.bin'] }))).toBeNull()
  })
})

describe('resolveAsrTools', () => {
  it('resolves the whole toolchain when it is staged', () => {
    const dir = toolsDir({ cli: true, models: ['ggml-base.en-q8_0.bin', VAD_FILE_NAME] })
    const result = resolveAsrTools({ toolsDir: dir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.model.name).toBe(DEFAULT_MODEL_NAME)
    expect(result.tools.model.dtw).toBe('base.en')
    expect(result.tools.vad).not.toBeNull()
    expect(result.tools.notes).toEqual([])
  })

  it('names the missing binary instead of failing three stages later', () => {
    const result = resolveAsrTools({ toolsDir: toolsDir({ models: ['ggml-base.en-q8_0.bin'] }) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.kind).toBe('missing-cli')
    expect(result.problem.remedy).toBe('npm run tools:install')
  })

  it('distinguishes "no models at all" from "that model is not staged"', () => {
    const none = resolveAsrTools({ toolsDir: toolsDir({ cli: true }) })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.problem.kind).toBe('missing-model')

    const wrongOne = resolveAsrTools({
      toolsDir: toolsDir({ cli: true, models: ['ggml-base.en-q8_0.bin'] }),
      model: 'medium.en-q5_0',
    })
    expect(wrongOne.ok).toBe(false)
    if (wrongOne.ok) return
    // The message has to say what IS available, or the user is left guessing.
    expect(wrongOne.problem.message).toContain('base.en-q8_0')
    expect(wrongOne.problem.remedy).toBe('npm run tools:install -- --model medium.en-q5_0')
  })

  it('falls back to a staged model when the default is absent, and says so', () => {
    const result = resolveAsrTools({
      toolsDir: toolsDir({ cli: true, models: ['ggml-large-v3-turbo-q8_0.bin'] }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.model.name).toBe('large-v3-turbo-q8_0')
    expect(result.tools.notes.join(' ')).toMatch(/default model .* is not staged/)
  })

  it('refuses a model it cannot get word timings for', () => {
    // Without -dtw there is no word timeline, and the whole app is sentence-level.
    const result = resolveAsrTools({
      toolsDir: toolsDir({ cli: true, models: ['ggml-distil-large-v3-q5_0.bin'] }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.kind).toBe('no-dtw')
  })

  it('drops --vad with a warning when the Silero weights are missing', () => {
    const result = resolveAsrTools({
      toolsDir: toolsDir({ cli: true, models: ['ggml-base.en-q8_0.bin'] }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.vad).toBeNull()
    expect(result.tools.notes.join(' ')).toMatch(/VAD/)
  })
})
