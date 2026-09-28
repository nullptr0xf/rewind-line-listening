'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
// Labels come from the shared, client-safe module. Importing the *value* from
// lib/server/download would pull better-sqlite3 into the browser bundle.
import { DOWNLOAD_STAGE_LABELS } from '@/lib/lesson/stages'
import type { DownloadJob } from '@/lib/server/download'
import { useDownloadJob } from '@/hooks/useDownloadJob'

/**
 * Import entry point #4: a URL.
 *
 * The other three (path, native dialog, CLI) all assume the file is already on
 * this machine. This one closes the gap: paste a link, and the downloader brings
 * it here — after which it is *exactly* the same pipeline, because the download
 * ends by calling `ingestFile()` on an absolute path like everything else.
 *
 * Two details that are easy to get wrong and are deliberate:
 *
 * 1. **The caption checkbox is on by default.** When the site has its own
 *    captions, the downloader writes them as a `.vtt` next to the media, and
 *    `findSiblingSubtitle` picks them up with no new code. The lesson is
 *    immediately playable, with timings from the platform's model rather than
 *    ours — and pressing Transcribe still overrides it, because re-transcription
 *    is an explicit action.
 *
 * 2. **The percentage comes from the server and is never animated towards a
 *    target.** A bar that keeps moving after the transfer has stopped is the one
 *    failure mode users never forgive.
 */

type UrlDownloadPanelProps = {
  /** Called once a download has produced a lesson, so the parent can reload. */
  onImported: (lessonId: string) => void
}

const STAGE_HINT: Partial<Record<DownloadJob['stage'], string>> = {
  probing: 'Asking the site what this URL is, and whether it has captions.',
  downloading: 'Transferring the media. The site decides the speed, not us.',
  importing: 'Reading the file, probing it, and adding it to the library.',
}

export function UrlDownloadPanel({ onImported }: UrlDownloadPanelProps) {
  const { job, refusal, starting, running, start, cancel, dismiss, clearRefusal } = useDownloadJob()
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'audio' | 'video'>('audio')
  const [captions, setCaptions] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  // 1 Hz is all the elapsed-time readout needs, and an interval that runs only
  // while a job is live costs nothing when nothing is happening.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      if (!url.trim()) return
      void start({ url: url.trim(), mode, captions })
    },
    [captions, mode, start, url],
  )

  const onCancel = useCallback(() => void cancel(), [cancel])

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-xl border border-line bg-surface p-4 shadow-sm"
    >
      <label htmlFor="download-url" className="block text-xs font-medium text-ink-soft">
        Or paste a video URL
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        YouTube and the other sites the downloader supports. The file is saved into this app&apos;s
        own folder and then treated exactly like a local import — same library, same player, same
        transcription.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          id="download-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          spellCheck={false}
          autoComplete="off"
          disabled={running}
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={running || starting || url.trim().length === 0}
          className="shrink-0 rounded-md bg-accent-strong px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent disabled:opacity-40"
        >
          {starting ? 'Starting…' : 'Download'}
        </button>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-ink-muted">
        <div className="flex items-center gap-1.5">
          <span className="text-ink-faint">Get</span>
          {(['audio', 'video'] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={running}
              onClick={() => setMode(option)}
              className={
                mode === option
                  ? 'rounded border border-accent-line bg-accent-wash px-2 py-0.5 text-accent-strong disabled:opacity-60'
                  : 'rounded border border-line-strong bg-sunken px-2 py-0.5 text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:opacity-60'
              }
            >
              {option === 'audio' ? 'audio only' : 'video'}
            </button>
          ))}
          <span className="text-ink-faint">
            {mode === 'audio'
              ? '— smaller, and all the transcription needs'
              : '— keeps the picture, capped at 720p'}
          </span>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={captions}
            disabled={running}
            onChange={(event) => setCaptions(event.target.checked)}
            className="size-3.5 accent-[var(--color-accent-strong)]"
          />
          <span>
            also fetch the site&apos;s captions
            <span className="text-ink-faint"> — if any, so it is playable at once</span>
          </span>
        </label>
      </div>

      {refusal ? (
        <div className="mt-3 rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2">
          <p className="text-[11px] font-medium text-amber-800">Cannot start</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">{refusal.message}</p>
          {refusal.remedy ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[10px] text-ink-soft">
              {refusal.remedy}
            </pre>
          ) : null}
          <button type="button" onClick={clearRefusal} className={`${secondaryClass} mt-2.5`}>
            Close
          </button>
        </div>
      ) : null}

      {job && running ? (
        <RunningDownload job={job} now={now} onCancel={onCancel} />
      ) : null}

      {job && job.stage === 'done' ? (
        <div className="mt-3 rounded-md border border-accent-line bg-accent-wash px-3 py-2">
          <p className="text-[11px] text-ink-soft">
            Downloaded{' '}
            <span className="font-medium text-accent-strong">{job.title || 'the video'}</span>
            {job.cueCount && job.cueCount > 0 ? (
              <> — {job.cueCount} lines from {job.transcriptSource}</>
            ) : (
              <> — no captions came with it, so press Transcribe when you open it</>
            )}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {job.lessonId ? (
              <Link
                href={`/watch/${encodeURIComponent(job.lessonId)}`}
                onClick={() => job.lessonId && onImported(job.lessonId)}
                className={primaryClass}
              >
                Open it
              </Link>
            ) : null}
            <button type="button" onClick={dismiss} className={secondaryClass}>
              Close
            </button>
          </div>
          {job.filePath ? (
            <p className="mt-2 truncate font-mono text-[10px] text-ink-faint">{job.filePath}</p>
          ) : null}
        </div>
      ) : null}

      {job && job.stage === 'failed' ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-[11px] font-medium text-red-700">Download failed</p>
          <p className="mt-1 text-[11px] leading-relaxed break-words text-ink-soft">
            {job.error ?? 'No reason was reported.'}
          </p>
          {job.remedy ? (
            <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[10px] text-ink-soft">
              {job.remedy}
            </pre>
          ) : null}
          {job.warnings.length > 0 ? <WarningList warnings={job.warnings} /> : null}
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={dismiss} className={secondaryClass}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {job && job.stage === 'cancelled' ? (
        <div className="mt-3 rounded-md border border-line bg-sunken px-3 py-2">
          <p className="text-[11px] text-ink-soft">Download cancelled.</p>
          <p className="mt-1 text-[11px] text-ink-muted">
            The partial file was removed. Nothing was added to the library.
          </p>
          <button type="button" onClick={dismiss} className={`${secondaryClass} mt-2.5`}>
            Close
          </button>
        </div>
      ) : null}
    </form>
  )
}

function RunningDownload({
  job,
  now,
  onCancel,
}: {
  job: DownloadJob
  now: number
  onCancel: () => void
}) {
  const elapsedSeconds = Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))
  const clamped = Math.max(0, Math.min(100, job.percent))
  const hint = STAGE_HINT[job.stage]

  return (
    <div className="mt-3 rounded-md border border-line bg-sunken px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-xs font-medium text-ink">
          {job.title || DOWNLOAD_STAGE_LABELS[job.stage]}
        </p>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
          {job.percent}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-valuetext={job.detail}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface ring-1 ring-line ring-inset"
      >
        <div
          className="h-full rounded-full bg-accent-strong transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft" aria-live="polite">
        {job.detail}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{hint}</p> : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
        <span className="font-mono tabular-nums">{formatElapsed(elapsedSeconds)} elapsed</span>
        {job.totalText ? <span>{job.totalText}</span> : null}
        {job.speed ? <span>{job.speed}</span> : null}
        {job.eta ? <span>ETA {job.eta}</span> : null}
        <span>{job.extractor ?? 'the site'}</span>
      </div>

      {job.warnings.length > 0 ? <WarningList warnings={job.warnings} /> : null}

      <button type="button" onClick={onCancel} className={`${secondaryClass} mt-2.5`}>
        Stop
      </button>
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

const primaryClass =
  'rounded-md bg-accent-strong px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-accent'

const secondaryClass =
  'rounded-md border border-line-strong bg-sunken px-2.5 py-1 text-[11px] text-ink-soft transition-colors hover:bg-raised hover:text-ink'
