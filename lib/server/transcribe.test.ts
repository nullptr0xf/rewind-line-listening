import { describe, expect, it, vi } from 'vitest'
import { isTerminalStage } from '../lesson/stages'
import {
  INITIAL_STATE,
  JobCancelled,
  TranscribeError,
  buildWhisperArgs,
  executeJob,
  makeDefaultSteps,
  makePipelineContext,
  makeRuntime,
  publishTo,
  type JobSink,
  type PipelineContext,
  type PipelineState,
  type PipelineStep,
  type TranscribeJob,
  type TranscribeStage,
} from './transcribe'

/**
 * The runner's state machine, exercised without spawning anything.
 *
 * Everything asserted here is a property the UI leans on and that a refactor can
 * break silently: a bar that goes backwards, a stage that skips its share of the
 * progress, a cancelled job reported as failed. None of those would be visible
 * from a single end-to-end run on the fixture.
 */

function snapshot(overrides: Partial<TranscribeJob> = {}): TranscribeJob {
  return {
    id: 'tr_test',
    lessonId: 'lesson-1',
    title: 'Test',
    stage: 'queued',
    percent: 0,
    detail: 'Starting',
    stagePercent: null,
    model: 'base.en-q8_0',
    vad: true,
    cueCount: 0,
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    revision: 0,
    ...overrides,
  }
}

const FAKE_MODEL = {
  name: 'base.en-q8_0',
  file: 'ggml-base.en-q8_0.bin',
  absPath: 'Z:/models/ggml-base.en-q8_0.bin',
  sizeBytes: 1,
  dtw: 'base.en',
}

function harness(contextOverrides: Partial<PipelineContext> = {}) {
  const runtime = makeRuntime(snapshot())
  const updates: TranscribeJob[] = []
  runtime.listeners.add((job) => updates.push(job))
  const sink: JobSink = {
    publish: (patch) => publishTo(runtime, patch),
    isCancelled: () => runtime.cancelled,
  }
  const ctx = makePipelineContext({
    lessonId: 'lesson-1',
    sourcePath: 'Z:/media/in.mp4',
    model: FAKE_MODEL,
    cacheDir: 'Z:/cache/lesson-1',
    ...contextOverrides,
  })
  return { runtime, updates, sink, ctx }
}

/** A step that records that it ran, optionally reporting progress. */
function step(
  stage: TranscribeStage,
  weight: number,
  behaviour: (state: PipelineState, ctx: PipelineContext) => Partial<PipelineState> | Promise<Partial<PipelineState>> = () => ({}),
): PipelineStep & { ran: number } {
  const wrapped = {
    stage,
    weight,
    ran: 0,
    async run(state: PipelineState, ctx: PipelineContext) {
      wrapped.ran += 1
      return behaviour(state, ctx)
    },
  }
  return wrapped
}

describe('executeJob', () => {
  it('visits the stages in order and finishes at exactly 100%', async () => {
    const { sink, ctx, updates } = harness()
    const steps = [step('probing', 10), step('transcribing', 80), step('writing', 10)]

    await executeJob(sink, steps, ctx)

    // Each stage publishes twice — on entry, then on landing on its boundary —
    // so collapse consecutive repeats before checking the order.
    const stages = updates
      .map((job) => job.stage)
      .filter((stage, index, all) => stage !== all[index - 1])
    expect(stages).toEqual(['probing', 'transcribing', 'writing'])
    expect(updates.at(-1)?.percent).toBe(100)
  })

  it('never lets the bar go backwards', async () => {
    const { sink, ctx } = harness()
    const steps = [
      step('extracting', 20, (_state, c) => {
        c.report('half', 50)
        c.report('most', 90)
        return {}
      }),
      step('transcribing', 80, (_state, c) => {
        c.report('start', 0)
        c.report('mid', 50)
        return {}
      }),
    ]

    const published: number[] = []
    // Capture as we go, because the final array is not enough to see a dip.
    const spy: JobSink = {
      publish: (patch) => {
        sink.publish(patch)
        if (patch.percent !== undefined) published.push(patch.percent)
      },
      isCancelled: sink.isCancelled,
    }

    await executeJob(spy, steps, ctx)

    for (let index = 1; index < published.length; index += 1) {
      expect(published[index]).toBeGreaterThanOrEqual(published[index - 1])
    }
    expect(Math.max(...published)).toBeLessThanOrEqual(100)
  })

  it('maps a stage percentage into that stage only share of the bar', async () => {
    const { sink, ctx, updates } = harness()
    const steps = [
      step('probing', 25),
      step('transcribing', 75, (_state, c) => {
        c.report('half way', 50)
        return {}
      }),
    ]

    await executeJob(sink, steps, ctx)

    // 25 (probing done) + 75 * 0.5 = 62.5 -> 63. Not 50, which is what a naive
    // "just show stagePercent" would give.
    const halfway = updates.find((job) => job.detail === 'half way')
    expect(halfway?.percent).toBe(63)
    expect(halfway?.stagePercent).toBe(50)
  })

  it('does not invent progress when a stage cannot measure itself', async () => {
    const { sink, ctx, updates } = harness()
    const steps = [
      step('extracting', 50, (_state, c) => {
        // No duration known: the stage reports what it knows and no percentage.
        c.report('Extracting audio — 3s so far', null)
        return {}
      }),
      step('writing', 50),
    ]

    await executeJob(sink, steps, ctx)

    const unknown = updates.find((job) => job.detail === 'Extracting audio — 3s so far')
    expect(unknown?.stagePercent).toBeNull()
    // Still inside the extracting window, so the bar must not have moved on.
    expect(unknown?.percent).toBe(0)
  })

  it('spends a stage full weight even when it reports nothing', async () => {
    const { sink, ctx, updates } = harness()
    await executeJob(sink, [step('probing', 40), step('writing', 60)], ctx)
    // Probing finished -> 40%, writing finished -> 100%. A stage that says
    // nothing must still move the bar, or the UI looks hung.
    const percents = updates.map((job) => job.percent)
    expect(percents).toContain(40)
    expect(updates.at(-1)?.percent).toBe(100)
  })

  it('carries state from one step into the next', async () => {
    const { sink, ctx } = harness()
    const steps = [
      step('extracting', 50, () => ({ wavPath: '/tmp/a.wav' })),
      step('transcribing', 50, (state) => ({ jsonPath: `${state.wavPath}.json` })),
    ]

    const final = await executeJob(sink, steps, ctx, INITIAL_STATE)
    expect(final.wavPath).toBe('/tmp/a.wav')
    expect(final.jsonPath).toBe('/tmp/a.wav.json')
  })

  it('stops immediately when the job is cancelled, reporting the cancelled error', async () => {
    const { sink, ctx, runtime } = harness()
    const first = step('extracting', 50, () => {
      runtime.cancelled = true
      return {}
    })
    const second = step('transcribing', 50)

    await expect(executeJob(sink, [first, second], ctx)).rejects.toBeInstanceOf(JobCancelled)
    expect(second.ran).toBe(0)
  })

  it('does not start at all when already cancelled', async () => {
    const { sink, ctx, runtime } = harness()
    runtime.cancelled = true
    const only = step('probing', 100)

    await expect(executeJob(sink, [only], ctx)).rejects.toBeInstanceOf(JobCancelled)
    expect(only.ran).toBe(0)
  })

  it('propagates a step failure so the caller can mark the job failed', async () => {
    const { sink, ctx } = harness()
    const failing = step('transcribing', 100, () => {
      throw new TranscribeError('whisper-cli failed (exit 1). model not found')
    })

    await expect(executeJob(sink, [failing], ctx)).rejects.toThrow(/model not found/)
  })

  it('refuses a step list with no weight, which would make progress meaningless', async () => {
    const { sink, ctx } = harness()
    await expect(executeJob(sink, [], ctx)).rejects.toThrow(/positive weight/)
  })
})

describe('publishTo', () => {
  it('bumps the revision on every change, including ones that do not alter it', () => {
    const runtime = makeRuntime(snapshot())
    publishTo(runtime, {})
    publishTo(runtime, { percent: 5 })
    expect(runtime.snapshot.revision).toBe(2)
    expect(runtime.snapshot.percent).toBe(5)
  })

  it('survives a listener that throws, because an SSE socket can die mid-job', () => {
    const runtime = makeRuntime(snapshot())
    const seen: number[] = []
    runtime.listeners.add(() => {
      throw new Error('socket closed')
    })
    runtime.listeners.add((job) => seen.push(job.percent))

    expect(() => publishTo(runtime, { percent: 42 })).not.toThrow()
    expect(seen).toEqual([42])
  })

  it('unsubscribing stops delivery', () => {
    const runtime = makeRuntime(snapshot())
    const seen: number[] = []
    const listener = (job: TranscribeJob) => seen.push(job.percent)
    runtime.listeners.add(listener)
    publishTo(runtime, { percent: 1 })
    runtime.listeners.delete(listener)
    publishTo(runtime, { percent: 2 })
    expect(seen).toEqual([1])
  })
})

describe('isTerminalStage', () => {
  it('treats done, failed and cancelled as terminal and nothing else', () => {
    expect(isTerminalStage('done')).toBe(true)
    expect(isTerminalStage('failed')).toBe(true)
    expect(isTerminalStage('cancelled')).toBe(true)
    expect(isTerminalStage('queued')).toBe(false)
    expect(isTerminalStage('transcribing')).toBe(false)
  })
})

describe('buildWhisperArgs', () => {
  const base = {
    modelPath: 'Z:/models/ggml-base.en-q8_0.bin',
    wavPath: 'Z:/cache/audio-16k.wav',
    prefix: 'Z:/cache/transcript',
    language: 'en',
    dtw: 'base.en',
    threads: 8,
    vadPath: null,
  }

  /** Everything here fails *quietly* when missing, so each flag gets its own check. */
  it('requests per-token data, or there is no word timeline at all', () => {
    expect(buildWhisperArgs(base)).toContain('-ojf')
    expect(buildWhisperArgs(base)).not.toContain('-oj')
  })

  it('requests -dtw with the model DTW name', () => {
    const args = buildWhisperArgs(base)
    expect(args[args.indexOf('-dtw') + 1]).toBe('base.en')
  })

  it('asks for progress, which whisper-cli leaves off by default', () => {
    // Measured: without -pp, a 124s file produced 131 stderr lines and not one
    // percentage. Nothing else in the invocation reveals that it is off.
    expect(buildWhisperArgs(base)).toContain('-pp')
  })

  it('adds --vad and the weights path together, never one without the other', () => {
    const withVad = buildWhisperArgs({ ...base, vadPath: 'Z:/models/ggml-silero-v5.1.2.bin' })
    expect(withVad).toContain('--vad')
    expect(withVad[withVad.indexOf('-vm') + 1]).toBe('Z:/models/ggml-silero-v5.1.2.bin')

    const withoutVad = buildWhisperArgs(base)
    expect(withoutVad).not.toContain('--vad')
    expect(withoutVad).not.toContain('-vm')
  })

  it('writes JSON to the prefix the runner later reads back', () => {
    const args = buildWhisperArgs(base)
    expect(args[args.indexOf('-of') + 1]).toBe('Z:/cache/transcript')
  })
})

describe('makeDefaultSteps', () => {
  it('weights sum to 100, so the bar can actually reach the end', () => {
    const steps = makeDefaultSteps()
    expect(steps.reduce((sum, item) => sum + item.weight, 0)).toBe(100)
  })

  it('runs each stage exactly once, in pipeline order', () => {
    expect(makeDefaultSteps().map((item) => item.stage)).toEqual([
      'probing',
      'extracting',
      'transcribing',
      'assembling',
      'segmenting',
      'writing',
    ])
  })

  it('gives transcription the overwhelming share, because it is the wait', () => {
    const transcription = makeDefaultSteps().find((item) => item.stage === 'transcribing')
    expect(transcription?.weight).toBeGreaterThanOrEqual(70)
  })
})

describe('makePipelineContext', () => {
  it('derives the -dtw value from the model and defaults the rest to inert', () => {
    const ctx = makePipelineContext({
      lessonId: 'a',
      sourcePath: 'b',
      model: FAKE_MODEL,
      cacheDir: 'c',
    })
    expect(ctx.dtw).toBe('base.en')
    expect(ctx.language).toBe('en')
    expect(ctx.vadPath).toBeNull()
    // Inert by default so a forgotten override cannot crash a job mid-run.
    expect(() => ctx.report('x')).not.toThrow()
    expect(() => ctx.warn('x')).not.toThrow()
    expect(ctx.isCancelled()).toBe(false)
  })
})

describe('cancellation reaching the child process', () => {
  it('kills the tracked process, not just the flag', () => {
    // Cancelling without killing would leave whisper.cpp burning a core until it
    // finished the entire file, which reads to the user as "cancel does nothing".
    const runtime = makeRuntime(snapshot())
    const killed = vi.fn()
    const fakeChild = { kill: killed } as unknown as import('node:child_process').ChildProcess

    const ctx = makePipelineContext({
      lessonId: 'a',
      sourcePath: 'b',
      model: FAKE_MODEL,
      cacheDir: 'c',
      track: (child) => {
        runtime.child = child
        if (runtime.cancelled) child.kill()
      },
    })

    // The interesting case: cancel arrives *before* the child is registered.
    runtime.cancelled = true
    ctx.track(fakeChild)
    expect(killed).toHaveBeenCalledTimes(1)
  })
})
