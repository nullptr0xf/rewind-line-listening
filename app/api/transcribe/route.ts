import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveJobForLesson, listJobs, startTranscription } from '@/lib/server/transcribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Transcription jobs.
 *
 * POST returns as soon as a job exists — it does not wait for the transcription.
 * A 45-minute file is minutes of work, and holding an HTTP request open for it
 * would be both fragile and pointless when the client can follow `GET
 * /api/transcribe/<id>?stream=1` instead.
 */

const startSchema = z.object({
  lessonId: z.string().min(1, 'A lesson id is required.'),
  model: z.string().optional(),
  language: z.string().optional(),
  force: z.boolean().optional(),
})

/**
 * Map a refusal onto the status that describes it. The UI shows different
 * affordances for each, so flattening them all to 400 would lose information
 * the client needs to react correctly.
 */
const STATUS_FOR_PROBLEM: Record<string, number> = {
  'no-such-lesson': 404,
  'already-running': 409,
  'has-transcript': 409,
  'source-missing': 409,
  'no-audio': 422,
  toolchain: 503,
}

/** GET /api/transcribe -> every job this process knows about, newest first. */
export async function GET(request: Request) {
  const lessonId = new URL(request.url).searchParams.get('lessonId')
  if (lessonId) {
    // The reattach path: after a page reload the UI asks what is running rather
    // than guessing from a job id it never stored.
    return NextResponse.json({ job: getActiveJobForLesson(lessonId) })
  }
  return NextResponse.json({ jobs: listJobs() })
}

/** POST /api/transcribe -> start a job. */
export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const parsed = startSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    )
  }

  const result = startTranscription(parsed.data)
  if (!result.ok) {
    const { problem } = result
    return NextResponse.json(
      { error: problem.message, code: problem.kind, remedy: problem.remedy ?? null, jobId: problem.jobId ?? null },
      { status: STATUS_FOR_PROBLEM[problem.kind] ?? 400 },
    )
  }

  return NextResponse.json({ job: result.job }, { status: 202 })
}
