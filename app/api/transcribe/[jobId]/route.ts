import { NextResponse } from 'next/server'
import { cancelJob, getJob, subscribe } from '@/lib/server/transcribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One job: its snapshot, or a live stream of snapshots.
 *
 *   GET    /api/transcribe/<id>            -> { job }            (one-shot)
 *   GET    /api/transcribe/<id>?stream=1   -> text/event-stream  (live)
 *   DELETE /api/transcribe/<id>            -> { cancelled: true }
 *
 * Every SSE frame carries the COMPLETE job, not a delta. That is the whole
 * reason this endpoint needs no replay buffer: a client that connects late, or
 * reconnects after a dropped socket, is immediately correct, because the newest
 * frame is self-sufficient. The payload is a few hundred bytes on loopback with
 * exactly one user, so the bandwidth argument for deltas does not apply here.
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
      if (job.stage === 'done' || job.stage === 'failed' || job.stage === 'cancelled') {
        finish()
        return
      }

      unsubscribe = subscribe(jobId, (snapshot) => {
        send(snapshot)
        if (snapshot.stage === 'done' || snapshot.stage === 'failed' || snapshot.stage === 'cancelled') {
          finish()
        }
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
