import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveJobForUrl, listJobs, startDownload } from '@/lib/server/download'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * URL downloads.
 *
 * POST returns as soon as a job exists — it does not wait for the download. A
 * 600 MB video is minutes of work, and holding an HTTP request open for it would
 * be both fragile and pointless when the client can follow
 * `GET /api/download/<id>?stream=1` instead. Same shape as /api/transcribe.
 */

const startSchema = z.object({
  url: z.string().min(1, 'A URL is required.'),
  mode: z.enum(['audio', 'video']).optional(),
  maxHeight: z.number().int().positive().max(4320).optional(),
  captions: z.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
})

/**
 * Map a refusal onto the status that describes it. The UI shows a different
 * affordance for each — a bad URL is a typo, a missing toolchain is a command to
 * run — so flattening them all to 400 would throw away what the client needs.
 */
const STATUS_FOR_PROBLEM: Record<string, number> = {
  'bad-url': 400,
  'already-running': 409,
  toolchain: 503,
  'no-destination': 500,
}

/** GET /api/download[?url=…] -> every job, or the one running for this URL. */
export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get('url')
  if (url) {
    // The reattach path: the UI never stores a job id, it asks what is running.
    return NextResponse.json({ job: getActiveJobForUrl(url) })
  }
  return NextResponse.json({ jobs: listJobs() })
}

/** POST /api/download -> start a job. */
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

  const result = await startDownload(parsed.data)
  if (!result.ok) {
    const { problem } = result
    return NextResponse.json(
      {
        error: problem.message,
        code: problem.kind,
        remedy: problem.remedy ?? null,
        jobId: problem.jobId ?? null,
      },
      { status: STATUS_FOR_PROBLEM[problem.kind] ?? 400 },
    )
  }

  return NextResponse.json({ job: result.job }, { status: 202 })
}
