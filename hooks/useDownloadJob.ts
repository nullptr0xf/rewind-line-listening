'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isDownloadFinished } from '@/lib/lesson/stages'
import type { DownloadJob } from '@/lib/server/download'

/**
 * Follow a URL-download job from the browser.
 *
 * Deliberately the same shape as `useTranscribeJob`, for the same two reasons:
 *
 * 1. **Reattach after a reload.** A download takes minutes; an accidental
 *    refresh must not lose it. `useTranscribeJob` can reattach because the page
 *    it lives on already knows a lesson id. There is no such handle here, so the
 *    last URL is kept in `localStorage` — the smallest thing that makes the same
 *    behaviour possible.
 *
 * 2. **Close the stream on a terminal frame.** `EventSource` reconnects
 *    automatically on any close — including a deliberate one — so a finished job
 *    would otherwise be re-requested in a loop for as long as the page is open.
 *    The server closes the stream when the job is terminal; we must close our
 *    side too, or the "automatic reconnect" works against us.
 */

export type DownloadRefusal = {
  message: string
  code: string | null
  remedy: string | null
  /** Set when the refusal was "already running" — the job to attach to instead. */
  jobId: string | null
}

export type DownloadStartOptions = {
  url: string
  mode?: 'audio' | 'video'
  maxHeight?: number
  captions?: boolean
  language?: string
}

export type UseDownloadJob = {
  job: DownloadJob | null
  refusal: DownloadRefusal | null
  /** True between clicking Download and the server answering. */
  starting: boolean
  running: boolean
  start: (options: DownloadStartOptions) => Promise<void>
  cancel: () => Promise<void>
  dismiss: () => void
  clearRefusal: () => void
}

/** Where the last submitted URL is kept, so a reload can reattach. */
export const LAST_URL_KEY = 'english-listening.download.url'

export function useDownloadJob(): UseDownloadJob {
  const [job, setJob] = useState<DownloadJob | null>(null)
  const [refusal, setRefusal] = useState<DownloadRefusal | null>(null)
  const [starting, setStarting] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  const detach = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
  }, [])

  const attach = useCallback(
    (jobId: string) => {
      detach()
      const source = new EventSource(`/api/download/${encodeURIComponent(jobId)}?stream=1`)
      sourceRef.current = source

      source.onmessage = (event) => {
        let snapshot: DownloadJob
        try {
          snapshot = JSON.parse(event.data) as DownloadJob
        } catch {
          return
        }
        setJob(snapshot)
        if (isDownloadFinished(snapshot.stage)) {
          // Close on our side, or EventSource reconnects to a finished job forever.
          detach()
        }
      }

      source.onerror = () => {
        // A closed stream is expected once the job is terminal. For anything
        // else, fall back rather than showing a transport error the user cannot
        // act on — the next action will retry.
        detach()
      }
    },
    [detach],
  )

  // Reattach on mount: a download started before a reload is still running on
  // the server, and the progress strip should come back by itself.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let url: string | null = null
      try {
        url = window.localStorage.getItem(LAST_URL_KEY)
      } catch {
        // Private mode, or storage disabled. Losing reattach is acceptable.
        return
      }
      if (!url) return

      try {
        const response = await fetch(`/api/download?url=${encodeURIComponent(url)}`, {
          cache: 'no-store',
        })
        if (!response.ok) return
        const data = (await response.json()) as { job: DownloadJob | null }
        if (cancelled || !data.job) return
        setJob(data.job)
        if (!isDownloadFinished(data.job.stage)) attach(data.job.id)
        else window.localStorage.removeItem(LAST_URL_KEY)
      } catch {
        /* the reattach attempt is best-effort */
      }
    })()
    return () => {
      cancelled = true
      detach()
    }
  }, [attach, detach])

  const start = useCallback(
    async (options: DownloadStartOptions) => {
      setStarting(true)
      setRefusal(null)
      try {
        const response = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        })
        const data = (await response.json()) as {
          job?: DownloadJob
          error?: string
          code?: string
          remedy?: string | null
          jobId?: string | null
        }

        if (!response.ok || !data.job) {
          setRefusal({
            message: data.error ?? `Could not start the download (${response.status}).`,
            code: data.code ?? null,
            remedy: data.remedy ?? null,
            jobId: data.jobId ?? null,
          })
          // "Already running" is not really a failure — attach to the live job.
          if (data.jobId) attach(data.jobId)
          return
        }

        try {
          window.localStorage.setItem(LAST_URL_KEY, options.url.trim())
        } catch {
          /* reattach is a convenience, not a requirement */
        }

        setJob(data.job)
        setRefusal(null)
        attach(data.job.id)
      } catch (cause) {
        setRefusal({
          message: cause instanceof Error ? cause.message : 'Could not start the download.',
          code: null,
          remedy: null,
          jobId: null,
        })
      } finally {
        setStarting(false)
      }
    },
    [attach],
  )

  const cancel = useCallback(async () => {
    const current = job
    if (!current) return
    try {
      const response = await fetch(`/api/download/${encodeURIComponent(current.id)}`, {
        method: 'DELETE',
      })
      const data = (await response.json()) as { job?: DownloadJob | null }
      if (data.job) setJob(data.job)
      detach()
    } catch {
      /* the job will report its own terminal state */
    }
  }, [detach, job])

  const dismiss = useCallback(() => {
    setJob(null)
    setRefusal(null)
    try {
      window.localStorage.removeItem(LAST_URL_KEY)
    } catch {
      /* nothing to clean up */
    }
  }, [])

  const clearRefusal = useCallback(() => setRefusal(null), [])

  return {
    job,
    refusal,
    starting,
    running: job !== null && !isDownloadFinished(job.stage),
    start,
    cancel,
    dismiss,
    clearRefusal,
  }
}
