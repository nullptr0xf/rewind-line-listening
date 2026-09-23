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
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-lg font-medium text-ink-100">English Listening</h1>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          A local, single-user trainer: video becomes a per-sentence transcript you can click,
          loop and sit on. Everything stays on this machine.
        </p>
      </header>

      <ImportPanel onImported={() => void refresh()} />

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-medium text-ink-300">Library</h2>
        <LessonList lessons={lessons} onChanged={() => void refresh()} />
      </section>
    </main>
  )
}
