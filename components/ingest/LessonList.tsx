'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { formatClock } from '@/lib/lesson/vtt'
import { TranscribePanel } from '@/components/transcribe/TranscribePanel'
import type { LessonSummary } from '@/lib/server/repo'

/**
 * The library: what you have imported, and nothing else.
 *
 * Note there is no "scan for new files" action anywhere — the list contains
 * exactly the files the user named. Removing an entry drops our index row and
 * our own cached JSON; it never touches the source file.
 */

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

type LessonListProps = {
  lessons: LessonSummary[]
  onChanged: () => void
}

export function LessonList({ lessons, onChanged }: LessonListProps) {
  const [pendingId, setPendingId] = useState<string | null>(null)

  const remove = useCallback(
    async (lesson: LessonSummary) => {
      const message = lesson.managed
        ? `Remove "${lesson.title}" from the library?\n\nThis deletes the copy this app stored under data/media.`
        : `Remove "${lesson.title}" from the library?\n\nYour source file will NOT be deleted:\n${lesson.sourcePath}\n\nOnly the transcript and progress stored by this app are removed.`

      if (!window.confirm(message)) return

      setPendingId(lesson.id)
      try {
        await fetch(`/api/lessons/${encodeURIComponent(lesson.id)}`, { method: 'DELETE' })
        onChanged()
      } finally {
        setPendingId(null)
      }
    },
    [onChanged],
  )

  if (lessons.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-xs text-ink-muted">
        Nothing imported yet. Add a file above, or run{' '}
        <code className="text-ink-soft">npm run ingest -- &quot;&lt;path&gt;&quot;</code> from the
        command line.
      </p>
    )
  }

  return (
    <ul className="space-y-2">
      {lessons.map((lesson) => (
        <li
          key={lesson.id}
          className="group flex items-center gap-4 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm transition-all hover:border-line-strong hover:shadow-md"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/watch/${encodeURIComponent(lesson.id)}`}
                className="truncate text-sm font-medium text-ink transition-colors hover:text-accent-strong"
              >
                {lesson.title}
              </Link>
              {lesson.missingSince ? (
                <span className="shrink-0 rounded border border-amber-600/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                  source missing
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
              <span className="font-mono tabular-nums">
                {lesson.durationMs ? formatClock(lesson.durationMs) : '--:--'}
              </span>
              <span>{formatSize(lesson.sizeBytes)}</span>
              <span>
                {lesson.cueCount > 0 ? `${lesson.cueCount} lines` : 'no transcript'}
              </span>
              {lesson.lastPositionMs > 0 ? (
                <span className="text-ink-faint">resume at {formatClock(lesson.lastPositionMs)}</span>
              ) : null}
            </div>

            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">{lesson.sourcePath}</p>
          </div>

          {/* A lesson with no transcript is the one case where this list offers an
              action other than "remove" — transcription is the only way such a
              lesson ever becomes usable, so the button belongs here rather than
              behind a click into the player. */}
          {lesson.cueCount === 0 && !lesson.missingSince ? (
            <TranscribePanel
              lessonId={lesson.id}
              variant="compact"
              onFinished={onChanged}
            />
          ) : null}

          <button
            type="button"
            onClick={() => remove(lesson)}
            disabled={pendingId === lesson.id}
            className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-muted opacity-0 transition-all hover:border-red-300 hover:bg-red-50 hover:text-red-700 group-hover:opacity-100 disabled:opacity-40"
          >
            {pendingId === lesson.id ? 'Removing…' : 'Remove'}
          </button>
        </li>
      ))}
    </ul>
  )
}