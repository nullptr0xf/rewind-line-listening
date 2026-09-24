'use client'

import { useCallback, useState } from 'react'
import { ImportPanel } from './ImportPanel'
import { LessonList } from './LessonList'
import type { LessonSummary } from '@/lib/server/repo'

/**
 * Client shell for the library page: owns the list so that importing or
 * removing an entry refreshes it without a full navigation.
 */

export function LibraryScreen({ initialLessons }: { initialLessons: LessonSummary[] }) {
  const [lessons, setLessons] = useState<LessonSummary[]>(initialLessons)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/lessons', { cache: 'no-store' })
      const data = (await response.json()) as { lessons: LessonSummary[] }
      setLessons(data.lessons)
    } catch {
      // Keep showing the previous list; the next action will retry.
    }
  }, [])

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-lg bg-accent-wash text-accent-strong ring-1 ring-accent-line"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
              <rect x="1" y="6" width="2" height="4" rx="1" />
              <rect x="4.5" y="3.5" width="2" height="9" rx="1" />
              <rect x="8" y="1.5" width="2" height="13" rx="1" />
              <rect x="11.5" y="4.5" width="2" height="7" rx="1" />
            </svg>
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">English Listening</h1>
        </div>
        <p className="mt-2.5 max-w-xl text-xs leading-relaxed text-ink-muted">
          A local, single-user trainer: video becomes a per-sentence transcript you can click,
          loop and sit on. Everything stays on this machine.
        </p>
      </header>

      <ImportPanel onImported={() => void refresh()} />

      <section className="mt-9">
        <h2 className="mb-3 text-xs font-medium tracking-wide text-ink-muted uppercase">
          Library
        </h2>
        <LessonList lessons={lessons} onChanged={() => void refresh()} />
      </section>
    </main>
  )
}
