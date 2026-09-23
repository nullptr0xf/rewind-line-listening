'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { formatClock } from '@/lib/lesson/vtt'
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
      <p className="rounded-lg border border-dashed border-ink-800 px-4 py-8 text-center text-xs text-ink-500">
        Nothing imported yet. Add a file above, or run{' '}
        <code className="text-ink-400">npm run ingest -- &quot;&lt;path&gt;&quot;</code> from the
        command line.
      </p>
    )
  }

  return (
    <ul className="space-y-2">
      {lessons.map((lesson) => (
        <li
          key={lesson.id}
          className="group flex items-center gap-4 rounded-lg border border-ink-800 bg-ink-900 px-4 py-3 transition-colors hover:border-ink-700"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/watch/${encodeURIComponent(lesson.id)}`}
                className="truncate text-sm font-medium text-ink-100 transition-colors hover:text-accent-400"
              >
                {lesson.title}
              </Link>
              {lesson.missingSince ? (
                <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                  source missing
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
              <span className="font-mono tabular-nums">
                {lesson.durationMs ? formatClock(lesson.durationMs) : '--:--'}
              </span>
              <span>{formatSize(lesson.sizeBytes)}</span>
              <span>
                {lesson.cueCount > 0 ? `${lesson.cueCount} lines` : 'no transcript'}
              </span>
              {lesson.lastPositionMs > 0 ? (
                <span className="text-ink-600">resume at {formatClock(lesson.lastPositionMs)}</span>
              ) : null}
            </div>

            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-600">{lesson.sourcePath}</p>
          </div>

          <button
            type="button"
            onClick={() => remove(lesson)}
            disabled={pendingId === lesson.id}
            className="shrink-0 rounded-md border border-ink-700 px-2.5 py-1 text-[11px] text-ink-400 opacity-0 transition-all hover:border-ink-600 hover:text-ink-200 group-hover:opacity-100 disabled:opacity-40"
          >
            {pendingId === lesson.id ? 'Removing…' : 'Remove'}
          </button>
        </li>
      ))}
    </ul>
  )
}
