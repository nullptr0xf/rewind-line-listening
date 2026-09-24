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
  transcriptPath: string | null
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
  const [dialogClosedEmpty, setDialogClosedEmpty] = useState(false)
  const [report, setReport] = useState<IngestReport | null>(null)

  const browse = useCallback(async () => {
    setBusy('browsing')
    setError(null)
    setDialogClosedEmpty(false)
    try {
      const response = await fetch('/api/ingest/pick', { method: 'POST' })
      const data = (await response.json()) as {
        path: string | null
        cancelled?: boolean
        error?: string
      }
      if (data.error) setError(data.error)
      else if (data.path) setPath(data.path)
      // Never fall through silently. "Clicked Browse and nothing happened" was
      // this branch doing nothing at all.
      else setDialogClosedEmpty(true)
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
    <form onSubmit={submit} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <label htmlFor="import-path" className="block text-xs font-medium text-ink-soft">
        Import a video or audio file
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        Paste an absolute path, or use Browse to pick one. A matching{' '}
        <code className="text-ink-muted">.srt</code> / <code className="text-ink-muted">.vtt</code> file
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
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-3 py-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <button
          type="button"
          onClick={browse}
          disabled={busy !== null}
          className="shrink-0 rounded-md border border-line-strong bg-sunken px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          {busy === 'browsing' ? 'Waiting…' : 'Browse…'}
        </button>
        <button
          type="submit"
          disabled={busy !== null || path.trim().length === 0}
          className="shrink-0 rounded-md bg-accent-strong px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent disabled:opacity-40"
        >
          {busy === 'importing' ? 'Importing…' : 'Import'}
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
          {error}
        </p>
      ) : null}

      {dialogClosedEmpty ? (
        <p className="mt-3 rounded-md border border-line bg-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          The file dialog closed without a selection. Nothing was imported. If no dialog appeared
          at all, paste the path into the field above instead.
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 rounded-md border border-accent-line bg-accent-wash px-3 py-2">
          <p className="text-[11px] text-ink-soft">
            {report.reused ? 'Already in the library — reusing it.' : 'Imported.'}{' '}
            <span className="text-ink-muted">
              {report.cueCount > 0
                ? `${report.cueCount} lines from ${report.transcriptSource}`
                : 'No transcript found yet'}
            </span>
          </p>
          {report.transcriptPath ? (
            <p className="mt-1 truncate font-mono text-[10px] text-ink-muted">
              {report.transcriptPath}
            </p>
          ) : null}
          {report.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {report.warnings.map((warning) => (
                <li key={warning} className="text-[11px] leading-relaxed text-amber-800">
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
