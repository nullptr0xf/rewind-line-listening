'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isTerminalStage } from '@/lib/lesson/stages'
import type { TranscribeJob } from '@/lib/server/transcribe'

/**
 * Follow a transcription job from the browser.
 *
 * Two things this hook has to get right, both of which are easy to get wrong:
 *
 * 1. **Reattach after a reload.** The job id is never stored in the browser. On
 *    mount we ask the server what is running for this lesson. A progress strip
 *    that vanishes on refresh would be worse than no progress strip.
 *
 * 2. **Close the stream on a terminal frame.** `EventSource` reconnects
 *    automatically on any close — including a deliberate one — so a finished job
 *    would otherwise be re-requested in a loop for as long as the page is open.
 *    The server closes the stream when the job is terminal; we must close our
 *    side too, or the "automatic reconnect" works against us.
 */

export type TranscribeRefusal = {
  message: string
  code: string | null
  remedy: string | null
  /** Set when the refusal was "already running" — the job to attach to instead. */
  jobId: string | null
}

export type UseTranscribeJob = {
  job: TranscribeJob | null
  refusal: TranscribeRefusal | null
  /** True between clicking Transcribe and the server answering. */
  starting: boolean
  running: boolean
  start: (options?: { force?: boolean; model?: string }) => Promise<void>
  cancel: () => Promise<void>
  dismiss: () => void
  clearRefusal: () => void
}

function isTerminal(stage: TranscribeJob['stage']): boolean {
  return isTerminalStage(stage)
}

export function useTranscribeJob(lessonId: string): UseTranscribeJob {
  const [job, setJob] = useState<TranscribeJob | null>(null)
  const [refusal, setRefusal] = useState<TranscribeRefusal | null>(null)
  const [starting, setStarting] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  const detach = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
  }, [])

  const attach = useCallback(
    (jobId: string) => {
      detach()
      const source = new EventSource(`/api/transcribe/${encodeURIComponent(jobId)}?stream=1`)
      sourceRef.current = source

      source.onmessage = (event) => {
        let snapshot: TranscribeJob
        try {
          snapshot = JSON.parse(event.data) as TranscribeJob
        } catch {
          return
        }
        setJob(snapshot)
        if (isTerminal(snapshot.stage)) {
          // Close on our side, or EventSource reconnects to a finished job forever.
          detach()
        }
      }

      source.onerror = () => {
        // A closed stream is expected once the job is terminal. For anything
        // else, fall back to one-shot reads on the next render cycle rather than
        // showing a transport error the user cannot act on.
        detach()
      }
    },
    [detach],
  )

  // Reattach: is something already running for this lesson?
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/transcribe?lessonId=${encodeURIComponent(lessonId)}`, {
          cache: 'no-store',
        })
        if (!response.ok) return
        const data = (await response.json()) as { job: TranscribeJob | null }
        if (cancelled || !data.job) return
        setJob(data.job)
        if (!isTerminal(data.job.stage)) attach(data.job.id)
      } catch {
        /* the reattach attempt is best-effort */
      }
    })()
    return () => {
      cancelled = true
      detach()
    }
  }, [attach, detach, lessonId])

  const start = useCallback(
    async (options: { force?: boolean; model?: string } = {}) => {
      setStarting(true)
      setRefusal(null)
      try {
        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lessonId,
            force: options.force ?? false,
            model: options.model,
          }),
        })
        const data = (await response.json()) as {
          job?: TranscribeJob
          error?: string
          code?: string
          remedy?: string | null
          jobId?: string | null
        }

        if (!response.ok || !data.job) {
          setRefusal({
            message: data.error ?? `Could not start transcription (${response.status}).`,
            code: data.code ?? null,
            remedy: data.remedy ?? null,
            jobId: data.jobId ?? null,
          })
          // "Already running" is not really a failure — attach to the live job.
          if (data.jobId) attach(data.jobId)
          return
        }

        setJob(data.job)
        setRefusal(null)
        attach(data.job.id)
      } catch (cause) {
        setRefusal({
          message: cause instanceof Error ? cause.message : 'Could not start transcription.',
          code: null,
          remedy: null,
          jobId: null,
        })
      } finally {
        setStarting(false)
      }
    },
    [attach, lessonId],
  )

  const cancel = useCallback(async () => {
    const current = job
    if (!current) return
    try {
      const response = await fetch(`/api/transcribe/${encodeURIComponent(current.id)}`, {
        method: 'DELETE',
      })
      const data = (await response.json()) as { job?: TranscribeJob | null }
      if (data.job) setJob(data.job)
      detach()
    } catch {
      /* the job will report its own terminal state */
    }
  }, [detach, job])

  const dismiss = useCallback(() => {
    setJob(null)
    setRefusal(null)
  }, [])

  const clearRefusal = useCallback(() => setRefusal(null), [])

  return {
    job,
    refusal,
    starting,
    running: job !== null && !isTerminal(job.stage),
    start,
    cancel,
    dismiss,
    clearRefusal,
  }
}
