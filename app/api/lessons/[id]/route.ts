import { NextResponse } from 'next/server'
import { z } from 'zod'
import { cueSchema } from '@/lib/lesson/schema'
import {
  getLessonRow,
  loadLesson,
  removeLesson,
  saveLesson,
  setDuration,
  setLastPosition,
  setTitle,
  toSummary,
} from '@/lib/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  lastPositionMs: z.number().int().nonnegative().optional(),
  /** Reported by the browser when ffprobe is not installed. */
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  cues: z.array(cueSchema).optional(),
})

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params
  const row = getLessonRow(id)
  if (!row) return NextResponse.json({ error: 'No such lesson.' }, { status: 404 })

  return NextResponse.json({ summary: toSummary(row), lesson: loadLesson(id) })
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params
  const row = getLessonRow(id)
  if (!row) return NextResponse.json({ error: 'No such lesson.' }, { status: 404 })

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    )
  }

  const patch = parsed.data
  if (patch.title) setTitle(id, patch.title)
  if (patch.lastPositionMs !== undefined) setLastPosition(id, patch.lastPositionMs)
  if (patch.durationMs !== undefined) setDuration(id, patch.durationMs, patch.width, patch.height)

  if (patch.cues) {
    const lesson = loadLesson(id)
    if (!lesson) return NextResponse.json({ error: 'lesson.json is unreadable.' }, { status: 500 })
    lesson.cues = patch.cues
    lesson.transcript.source = lesson.transcript.source === 'none' ? 'manual-vtt' : lesson.transcript.source
    saveLesson(lesson)
  }

  const updated = getLessonRow(id)
  return NextResponse.json({ summary: updated ? toSummary(updated) : null })
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params
  const url = new URL(request.url)
  const deleteManagedFile = url.searchParams.get('deleteManagedFile') === 'true'

  const row = getLessonRow(id)
  if (!row) return NextResponse.json({ error: 'No such lesson.' }, { status: 404 })

  removeLesson(id, { deleteManagedFile })

  return NextResponse.json({
    removed: id,
    // Reassure the caller explicitly: the user's own file is untouched.
    sourceFileDeleted: deleteManagedFile && row.managed === 1,
    sourcePathKept: row.managed === 1 ? null : row.source_path,
  })
}
