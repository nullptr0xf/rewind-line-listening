import { notFound } from 'next/navigation'
import { WatchScreen } from '@/components/watch/WatchScreen'
import { getLessonRow, loadLesson, toSummary } from '@/lib/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ lessonId: string }> }

export default async function WatchPage({ params }: PageProps) {
  const { lessonId } = await params
  const id = decodeURIComponent(lessonId)

  const row = getLessonRow(id)
  const lesson = loadLesson(id)
  if (!row || !lesson) notFound()

  return <WatchScreen lesson={lesson} summary={toSummary(row)} />
}
