import { NextResponse } from 'next/server'
import { z } from 'zod'
import { IngestError, ingestFile } from '@/lib/server/ingest'
import { listLessons } from '@/lib/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ingestRequestSchema = z.object({
  path: z.string().min(1, 'A file path is required.'),
  title: z.string().optional(),
  subtitlePath: z.string().optional(),
  force: z.boolean().optional(),
})

/** GET /api/ingest -> the lesson library. */
export async function GET() {
  return NextResponse.json({ lessons: listLessons() })
}

/** POST /api/ingest -> import a file by absolute path. */
export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const parsed = ingestRequestSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    )
  }

  try {
    const report = await ingestFile(parsed.data)
    return NextResponse.json(report, { status: report.created ? 201 : 200 })
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
    }
    console.error('[api/ingest] unexpected failure', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Import failed.' },
      { status: 500 },
    )
  }
}
