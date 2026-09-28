import { NextResponse } from 'next/server'
import { cancelJob, getJob, subscribe } from '@/lib/server/download'
import { isDownloadFinished } from '@/lib/lesson/stages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One download job: its snapshot, or a live stream of snapshots.
 *
 *   GET    /api/download/<id>            -> { job }            (one-shot)
 *   GET    /api/download/<id>?stream=1   -> text/event-stream  (live)
 *   DELETE /api/download/<id>            -> { cancelled: true }
 *
 * Every SSE frame carries the COMPLETE job, not a delta, exactly as the
 * transcription route does. A client that connects late or reconnects after a
 * dropped socket is immediately correct, with no replay buffer.
 *
 * A download is the noisiest job in the app — youtube-dl emits a progress line
 * per DASH fragment — so the runner publishes only when a *displayed* value
 * changes (`reportTransfer` in lib/server/download.ts). Without that, a single
 * transfer would push thousands of identical frames.
 */

type RouteContext = { params: Promise<{ jobId: string }> }

/** Comment-only keepalive. Also flushes any buffering proxy. */
const HEARTBEAT_MS = 15_000

export async function GET(request: Request, context: RouteContext) {
  const { jobId } = await context.params
  const job = getJob(jobId)
  if (!job) return NextResponse.json({ error: 'No such job.' }, { status: 404 })

  if (new URL(request.url).searchParams.get('stream') !== '1') {
    return NextResponse.json({ job })
  }

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false

      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // The client went away between our check and the write.
          closed = true
        }
      }

      const send = (payload: unknown) => write(`data: ${JSON.stringify(payload)}\n\n`)

      const finish = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe?.()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }

      // The first frame is the current state, so the client never renders an
      // empty progress strip while waiting for the next change to arrive.
      send(job)

      // A job that already finished has nothing more to say; close immediately
      // rather than leaving a stream open forever.
      if (isDownloadFinished(job.stage)) {
        finish()
        return
      }

      unsubscribe = subscribe(jobId, (snapshot) => {
        send(snapshot)
        if (isDownloadFinished(snapshot.stage)) finish()
      })

      heartbeat = setInterval(() => write(': keepalive\n\n'), HEARTBEAT_MS)
      request.signal.addEventListener('abort', finish)
    },

    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // Belt and braces: tells any intermediary not to buffer the stream, which
      // is what turns "live progress" into "all the updates at the very end".
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { jobId } = await context.params
  const job = getJob(jobId)
  if (!job) return NextResponse.json({ error: 'No such job.' }, { status: 404 })

  const cancelled = cancelJob(jobId)
  return NextResponse.json({ cancelled, job: getJob(jobId) })
}
