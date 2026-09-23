import { NextResponse } from 'next/server'
import { listLessons } from '@/lib/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/lessons -> the library, newest first. */
export async function GET() {
  return NextResponse.json({ lessons: listLessons() })
}
