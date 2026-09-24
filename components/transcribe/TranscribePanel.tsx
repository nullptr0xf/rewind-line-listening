'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
// Labels come from the shared, client-safe module. Importing the *value* from
// lib/server/transcribe would pull better-sqlite3 into the browser bundle.
import { STAGE_LABELS } from '@/lib/lesson/stages'
import type { TranscribeJob } from '@/lib/server/transcribe'
import { useTranscribeJob } from '@/hooks/useTranscribeJob'

/**
 * The transcription progress strip.
 *
 * Two variants of one component, because the same job is watched from two
 * places: `full` on the player screen where there is no transcript yet (the
 * panel *is* the content), and `compact` inline in a library row.
 *
 * The percent comes from the server. Nothing here estimates, smooths or
 * animates it towards a target — a bar that keeps moving after the work has
 * stopped is the one failure mode users never forgive.
 */

type TranscribePanelProps = {
  lessonId: string
  /** `compact` renders a single row for a list; `full` renders the card. */
  variant?: 'full' | 'compact'
  /** Called once when a job reaches `done`, so the parent can reload its data. */
  onFinished?: (job: TranscribeJob) => void
}

const STAGE_HINT: Partial<Record<TranscribeJob['stage'], string>> = {
  probing: 'Checking the file and its audio track.',
  extracting: 'Pulling the audio out at 16 kHz mono, which is what whisper.cpp reads.',
  transcribing: 'whisper.cpp is listening. This is the long one.',
  assembling: 'Turning token timings into a word timeline.',
  segmenting: 'Splitting the words into sentences you can loop.',
  writing: 'Saving the transcript.',
}

export function TranscribePanel({ lessonId, variant = 'full', onFinished }: TranscribePanelProps) {
  const { job, refusal, starting, running, start, cancel, dismiss, clearRefusal } =
    useTranscribeJob(lessonId)
  const [now, setNow] = useState(() => Date.now())
  const reportedRef = useRef<string | null>(null)

  // Fire onFinished exactly once per job, so a parent that reloads does not
  // reload again on every subsequent render.
  useEffect(() => {
    if (!job || job.stage !== 'done') return
    if (reportedRef.current === job.id) return
    reportedRef.current = job.id
    onFinished?.(job)
  }, [job, onFinished])

  // 1 Hz is all the elapsed-time readout needs, and an interval that runs only
  // while a job is live costs nothing when nothing is happening.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const onStart = useCallback(() => void start(), [start])
  const onCancel = useCallback(() => void cancel(), [cancel])

  if (job && running) {
    return (
      <RunningPanel job={job} now={now} variant={variant} onCancel={onCancel} />
    )
  }

  if (job && job.stage === 'failed') {
    return (
      <div className={cardClass(variant)}>
        <p className="text-xs font-medium text-red-700">Transcription failed</p>
        <p className="mt-1.5 text-[11px] leading-relaxed break-words text-ink-soft">
          {job.error ?? 'No reason was reported.'}
        </p>
        {job.warnings.length > 0 ? <WarningList warnings={job.warnings} /> : null}
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onStart} disabled={starting} className={primaryClass}>
            {starting ? 'Starting…' : 'Try again'}
          </button>
          <button type="button" onClick={dismiss} className={secondaryClass}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  if (job && job.stage === 'cancelled') {
    return (
      <div className={cardClass(variant)}>
        <p className="text-xs font-medium text-ink-soft">Transcription cancelled</p>
        <p className="mt-1 text-[11px] text-ink-muted">Nothing was written.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onStart} disabled={starting} className={primaryClass}>
            {starting ? 'Starting…' : 'Start again'}
          </button>
          <button type="button" onClick={dismiss} className={secondaryClass}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  if (job && job.stage === 'done') {
    return (
      <div className={cardClass(variant)}>
        <p className="text-xs font-medium text-accent-strong">
          Transcribed — {job.cueCount} lines
        </p>
        <p className="mt-1 text-[11px] text-ink-muted">
          {job.model}
          {job.vad ? ' · Silero VAD' : ' · no VAD'} · word timings
        </p>
      </div>
    )
  }

  if (refusal) {
    return (
      <div className={cardClass(variant)}>
        <p className="text-xs font-medium text-amber-800">Cannot start</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{refusal.message}</p>
        {refusal.remedy ? (
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[10px] text-ink-soft">
            {refusal.remedy}
          </pre>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={clearRefusal} className={secondaryClass}>
            Close
          </button>
        </div>
      </div>
    )
  }

  // Idle. `compact` gets just the button so a library row stays a row.
  if (variant === 'compact') {
    return (
      <button type="button" onClick={onStart} disabled={starting} className={primaryClass}>
        {starting ? 'Starting…' : 'Transcribe'}
      </button>
    )
  }

  return (
    <div className={cardClass(variant)}>
      <p className="text-xs font-medium text-ink">No transcript yet</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
        There is no subtitle file next to this video, so the transcript has to come from the
        audio. It runs locally with whisper.cpp — nothing is uploaded, and a long file takes a
        few minutes.
      </p>
      <button type="button" onClick={onStart} disabled={starting} className={`${primaryClass} mt-3`}>
        {starting ? 'Starting…' : 'Transcribe this file'}
      </button>
    </div>
  )
}

function RunningPanel({
  job,
  now,
  variant,
  onCancel,
}: {
  job: TranscribeJob
  now: number
  variant: 'full' | 'compact'
  onCancel: () => void
}) {
  const elapsedSeconds = Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))
  const headline = STAGE_LABELS[job.stage]
  const hint = STAGE_HINT[job.stage]

  if (variant === 'compact') {
    return (
      <div className="flex min-w-[180px] flex-col gap-1">
        <div className="flex items-center gap-2">
          <Bar percent={job.percent} detail={job.detail} />
          <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-muted">
            {job.percent}%
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700"
          >
            Stop
          </button>
        </div>
        <p className="truncate text-[10px] text-ink-muted">{job.detail}</p>
      </div>
    )
  }

  return (
    <div className={cardClass(variant)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-ink">{headline}</p>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
          {job.percent}%
        </span>
      </div>

      <div className="mt-2">
        <Bar percent={job.percent} detail={job.detail} />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft" aria-live="polite">
        {job.detail}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{hint}</p> : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
        <span className="font-mono tabular-nums">{formatElapsed(elapsedSeconds)} elapsed</span>
        <span>{job.model}</span>
        <span>{job.vad ? 'Silero VAD' : 'no VAD'}</span>
      </div>

      {job.warnings.length > 0 ? <WarningList warnings={job.warnings} /> : null}

      <button type="button" onClick={onCancel} className={`${secondaryClass} mt-3`}>
        Stop
      </button>
    </div>
  )
}

function Bar({ percent, detail }: { percent: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-valuetext={detail}
      className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken ring-1 ring-line ring-inset"
    >
      <div
        className="h-full rounded-full bg-accent-strong transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {warnings.map((warning) => (
        <li key={warning} className="text-[11px] leading-relaxed text-amber-800">
          {warning}
        </li>
      ))}
    </ul>
  )
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`
}

function cardClass(variant: 'full' | 'compact'): string {
  return variant === 'full'
    ? 'rounded-xl border border-line bg-surface p-4 shadow-sm'
    : 'rounded-lg border border-line bg-surface p-3'
}

const primaryClass =
  'rounded-md bg-accent-strong px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent disabled:opacity-40'

const secondaryClass =
  'rounded-md border border-line-strong bg-sunken px-2.5 py-1 text-[11px] text-ink-soft transition-colors hover:bg-raised hover:text-ink'
