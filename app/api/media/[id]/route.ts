import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'
import { getLessonRow, markSourceMissing } from '@/lib/server/repo'
import { contentRangeHeader, parseRangeHeader } from '@/lib/server/range'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/media/<lessonId> -> byte-range streaming of the source file.
 *
 * This route is why the project is a server app and not a static page.
 * Drag-to-seek in <video> is implemented by the browser as HTTP Range requests,
 * and Next's static file hosting does not give us control over the 206
 * response. Here we own it, so the scrubber behaves exactly like a local player.
 *
 * The source file is opened read-only and is never modified.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
}

type RouteContext = { params: Promise<{ id: string }> }

async function serveMedia(request: Request, rawId: string, headOnly: boolean): Promise<Response> {
  const id = decodeURIComponent(rawId)

  const row = getLessonRow(id)
  if (!row) {
    return NextResponse.json({ error: 'No such lesson.', code: 'not-found' }, { status: 404 })
  }

  const filePath = row.source_path
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(filePath)
  } catch {
    // Do NOT delete anything: just flag the lesson so the library can offer
    // "relocate file" instead of silently losing the transcript and favourites.
    markSourceMissing(id, new Date().toISOString())
    return NextResponse.json(
      {
        error: `The source file is not reachable: ${filePath}`,
        code: 'source-missing',
      },
      { status: 404 },
    )
  }

  if (row.missing_since) markSourceMissing(id, null)

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  }

  const range = parseRangeHeader(request.headers.get('range'), stat.size)

  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${stat.size}` },
    })
  }

  if (range.kind === 'full') {
    headers['Content-Length'] = String(stat.size)
    if (headOnly) return new Response(null, { status: 200, headers })
    const stream = fs.createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers,
    })
  }

  const { start, end } = range
  headers['Content-Range'] = contentRangeHeader(start, end, stat.size)
  headers['Content-Length'] = String(end - start + 1)
  if (headOnly) return new Response(null, { status: 206, headers })

  const stream = fs.createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 206,
    headers,
  })
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  return serveMedia(request, id, false)
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  return serveMedia(request, id, true)
}
