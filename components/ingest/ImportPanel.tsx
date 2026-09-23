'use client'

import { useCallback, useState } from 'react'

/**
 * Import entry point #1: an explicit path.
 *
 * There is no folder scanning anywhere in this app, by design. You name one
 * file — typed, pasted, or chosen through the native file dialog — and that is
 * what gets imported. The dialog exists because it is the only way to obtain a
 * real absolute path from the OS, which is the value the whole pipeline runs on.
 */

export type IngestReport = {
  lessonId: string
  created: boolean
  reused: boolean
  title: string
  absPath: string
  cueCount: number
  transcriptSource: string
  warnings: string[]
  probe: {
    available: boolean
    error: string | null
    durationMs: number | null
    hasAudio: boolean
    embeddedSubtitleCount: number
  }
}

type ImportPanelProps = {
  onImported: (lessonId: string) => void
}

export function ImportPanel({ onImported }: ImportPanelProps) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState<null | 'browsing' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<IngestReport | null>(null)

  const browse = useCallback(async () => {
    setBusy('browsing')
    setError(null)
    try {
      const response = await fetch('/api/ingest/pick', { method: 'POST' })
      const data = (await response.json()) as { path: string | null; error?: string }
      if (data.error) setError(data.error)
      else if (data.path) setPath(data.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the file dialog.')
    } finally {
      setBusy(null)
    }
  }, [])

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!path.trim()) return

      setBusy('importing')
      setError(null)
      setReport(null)

      try {
        const response = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path.trim() }),
        })
        const data = (await response.json()) as IngestReport & { error?: string }

        if (!response.ok || data.error) {
          setError(data.error ?? `Import failed (${response.status}).`)
          return
        }

        setReport(data)
        onImported(data.lessonId)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Import failed.')
      } finally {
        setBusy(null)
      }
    },
    [onImported, path],
  )

  return (
    <form onSubmit={submit} className="rounded-lg border border-ink-800 bg-ink-900 p-4">
      <label htmlFor="import-path" className="block text-xs font-medium text-ink-300">
        Import a video or audio file
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
        Paste an absolute path, or use Browse to pick one. A matching{' '}
        <code className="text-ink-400">.srt</code> / <code className="text-ink-400">.vtt</code> file
        sitting next to the video is picked up automatically. Your file is read in place and never
        copied or modified.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          id="import-path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="F:\videos\ep01.mp4"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-ink-100 outline-none placeholder:text-ink-600 focus:border-ink-500"
        />
        <button
          type="button"
          onClick={browse}
          disabled={busy !== null}
          className="shrink-0 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-100 disabled:opacity-50"
        >
          {busy === 'browsing' ? 'Waiting…' : 'Browse…'}
        </button>
        <button
          type="submit"
          disabled={busy !== null || path.trim().length === 0}
          className="shrink-0 rounded-md bg-accent-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-500 disabled:opacity-40"
        >
          {busy === 'importing' ? 'Importing…' : 'Import'}
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[11px] leading-relaxed text-red-300">
          {error}
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
          <p className="text-[11px] text-ink-200">
            {report.reused ? 'Already in the library — reusing it.' : 'Imported.'}{' '}
            <span className="text-ink-400">
              {report.cueCount > 0
                ? `${report.cueCount} lines from ${report.transcriptSource}`
                : 'No transcript found yet'}
            </span>
          </p>
          {report.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {report.warnings.map((warning) => (
                <li key={warning} className="text-[11px] leading-relaxed text-amber-300/90">
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
