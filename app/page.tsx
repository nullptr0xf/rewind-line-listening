import { LibraryScreen } from '@/components/ingest/LibraryScreen'
import { listLessons } from '@/lib/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The library is read straight from SQLite on the server — no HTTP round trip
 * on first paint, and no client-side cache to go stale.
 */
export default function HomePage() {
  const lessons = listLessons()
  return <LibraryScreen initialLessons={lessons} />
}
