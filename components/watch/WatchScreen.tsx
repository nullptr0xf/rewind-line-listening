'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef } from 'react'
import { usePlaybackClock, type PlaybackClock } from '@/hooks/usePlaybackClock'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import { findCueIndexAtOrBefore, findNextCueIndex, findPreviousCueIndex } from '@/lib/sync/findActiveCue'
import { usePlayerStore, type LoopMode } from '@/lib/store/playerStore'
import { VideoPane } from '@/components/player/VideoPane'
import { ControlBar } from '@/components/player/ControlBar'
import { TranscriptList } from '@/components/transcript/TranscriptList'
import type { Cue, Lesson } from '@/lib/lesson/schema'
import type { LessonSummary } from '@/lib/server/repo'

/**
 * The player screen: video on the left, clickable transcript on the right.
 *
 * Layout note: a true left/right split (not video-on-top) is what makes
 * "sit on one sentence for a while" comfortable — the transcript stays fully
 * visible while the picture keeps running.
 */

/** Seek a hair before the line ends so we never overrun it. */
const LOOP_EPSILON_MS = 40
/** Ignore repeat triggers for a moment after a programmatic seek. */
const SEEK_COOLDOWN_MS = 350
const POSITION_SAVE_INTERVAL_MS = 5000

type WatchScreenProps = {
  lesson: Lesson
  summary: LessonSummary
}

type LoopState = { cueIndex: number; repeats: number; done: boolean }

export function WatchScreen({ lesson, summary }: WatchScreenProps) {
  const cues = lesson.cues
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playerShellRef = useRef<HTMLDivElement | null>(null)

  const clock: PlaybackClock = usePlaybackClock(videoRef, cues)
  const autoScroll = useAutoScroll(clock.activeIndex)
  const { scrollToIndex, resumeFollow } = autoScroll

  const rate = usePlayerStore((state) => state.rate)
  const loopMode = usePlayerStore((state) => state.loopMode)
  const loopCount = usePlayerStore((state) => state.loopCount)
  const autoPlayOnJump = usePlayerStore((state) => state.autoPlayOnJump)
  const pauseAfterLine = usePlayerStore((state) => state.pauseAfterLine)
  const pauseDurationMs = usePlayerStore((state) => state.pauseDurationMs)
  const setLoopMode = usePlayerStore((state) => state.setLoopMode)
  const setLoopCount = usePlayerStore((state) => state.setLoopCount)
  const setAutoPlayOnJump = usePlayerStore((state) => state.setAutoPlayOnJump)
  const setPauseAfterLine = usePlayerStore((state) => state.setPauseAfterLine)
  const setPauseDurationMs = usePlayerStore((state) => state.setPauseDurationMs)

  const loopStateRef = useRef<LoopState>({ cueIndex: -1, repeats: 0, done: false })
  const lastSeekAtRef = useRef(0)
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cuesRef = useRef<readonly Cue[]>(cues)
  const settingsRef = useRef({ loopMode, loopCount, pauseAfterLine, pauseDurationMs })
  useEffect(() => {
    cuesRef.current = cues
  }, [cues])
  useEffect(() => {
    settingsRef.current = { loopMode, loopCount, pauseAfterLine, pauseDurationMs }
  }, [loopMode, loopCount, pauseAfterLine, pauseDurationMs])

  // Rehydrate persisted preferences after mount (see playerStore).
  useEffect(() => {
    void usePlayerStore.persist.rehydrate()
  }, [])

  /**
   * Repeat-one and pause-after-line, both driven from the frame clock rather
   * than from media events: `ended` never fires for a middle line, and
   * `timeupdate` is far too coarse (4 Hz) to cut a line precisely.
   */
  useEffect(() => {
    return clock.subscribe((timeMs) => {
      const video = videoRef.current
      if (!video || video.paused || video.seeking) return

      const list = cuesRef.current
      if (list.length === 0) return

      const index = findCueIndexAtOrBefore(list, timeMs)
      if (index < 0) return
      const cue = list[index]

      const state = loopStateRef.current
      if (state.cueIndex !== index) {
        loopStateRef.current = { cueIndex: index, repeats: 0, done: false }
      }

      if (timeMs < cue.end - LOOP_EPSILON_MS) return
      if (loopStateRef.current.done) return

      const settings = settingsRef.current

      if (settings.loopMode === 'off') {
        if (!settings.pauseAfterLine) return
        video.pause()
        if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
        pauseTimerRef.current = setTimeout(() => {
          pauseTimerRef.current = null
          const element = videoRef.current
          if (element) void element.play()
        }, settings.pauseDurationMs)
        return
      }

      if (performance.now() - lastSeekAtRef.current < SEEK_COOLDOWN_MS) return

      loopStateRef.current.repeats += 1

      if (settings.loopMode === 'sentence-n' && loopStateRef.current.repeats >= settings.loopCount) {
        // Finished the requested number of passes: let playback move on, and do
        // not re-loop this line when the counter would tick again.
        loopStateRef.current.done = true
        return
      }

      lastSeekAtRef.current = performance.now()
      video.currentTime = cue.start / 1000
    })
  }, [clock])

  useEffect(() => {
    return () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    }
  }, [])

  const handleSelect = useCallback(
    (index: number) => {
      const video = videoRef.current
      const cue = cuesRef.current[index]
      if (!video || !cue) return

      video.currentTime = cue.start / 1000 + 0.005
      loopStateRef.current = { cueIndex: index, repeats: 0, done: false }
      scrollToIndex(index)
      if (autoPlayOnJump) void video.play()
    },
    [autoPlayOnJump, scrollToIndex],
  )

  const stepLine = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current
      const list = cuesRef.current
      if (!video || list.length === 0) return
      const timeMs = clock.getTimeMs()
      const index =
        direction === 1 ? findNextCueIndex(list, timeMs) : findPreviousCueIndex(list, timeMs)
      handleSelect(index)
    },
    [clock, handleSelect],
  )

  // Restore the previous position, and report metadata back when ffprobe was
  // unavailable (the <video> element knows things ffprobe would have told us).
  const handledMetadataRef = useRef(false)
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video || handledMetadataRef.current) return
    handledMetadataRef.current = true

    if (summary.lastPositionMs > 5000 && summary.lastPositionMs < (video.duration || 0) * 1000 - 5000) {
      video.currentTime = summary.lastPositionMs / 1000
    }

    if (lesson.video.durationMs === null && Number.isFinite(video.duration) && video.duration > 0) {
      void fetch(`/api/lessons/${encodeURIComponent(lesson.video.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          durationMs: Math.round(video.duration * 1000),
          width: video.videoWidth || undefined,
          height: video.videoHeight || undefined,
        }),
      }).catch(() => {
        /* metadata is a nicety, never block playback on it */
      })
    }
  }, [lesson.video.durationMs, lesson.video.id, summary.lastPositionMs])

  // Persist the playhead periodically and when leaving the page.
  const lastSavedRef = useRef(summary.lastPositionMs)
  useEffect(() => {
    const save = (force: boolean) => {
      const timeMs = Math.round(clock.getTimeMs())
      if (!force && Math.abs(timeMs - lastSavedRef.current) < 3000) return
      lastSavedRef.current = timeMs
      void fetch(`/api/lessons/${encodeURIComponent(lesson.video.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastPositionMs: timeMs }),
        keepalive: true,
      }).catch(() => {})
    }

    const interval = setInterval(() => save(false), POSITION_SAVE_INTERVAL_MS)
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save(true)
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onHidden)
      save(true)
    }
  }, [clock, lesson.video.id])

  const activeIndex = clock.activeIndex

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
        <Link
          href="/"
          className="text-xs text-ink-muted transition-colors hover:text-ink"
        >
          Library
        </Link>
        <span className="text-ink-faint">/</span>
        <h1 className="truncate text-sm font-medium text-ink">{summary.title}</h1>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-muted">
          {cues.length} lines
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* LEFT: picture + transport */}
        <div ref={playerShellRef} className="flex min-w-0 flex-1 flex-col bg-canvas">
          <VideoPane
            videoRef={videoRef}
            src={`/api/media/${encodeURIComponent(lesson.video.id)}`}
            title={summary.title}
            missingSince={lesson.video.missingSince}
            onLoadedMetadata={handleLoadedMetadata}
          />
          <ControlBar
            videoRef={videoRef}
            clock={clock}
            fullscreenContainerRef={playerShellRef}
            onPreviousLine={() => stepLine(-1)}
            onNextLine={() => stepLine(1)}
          />
        </div>

        {/* RIGHT: transcript + practice controls */}
        <aside className="flex w-[42%] min-w-[340px] max-w-[640px] shrink-0 flex-col border-l border-line bg-surface">
          <PracticeBar
            loopMode={loopMode}
            loopCount={loopCount}
            autoPlayOnJump={autoPlayOnJump}
            pauseAfterLine={pauseAfterLine}
            pauseDurationMs={pauseDurationMs}
            onLoopMode={setLoopMode}
            onLoopCount={setLoopCount}
            onAutoPlayOnJump={setAutoPlayOnJump}
            onPauseAfterLine={setPauseAfterLine}
            onPauseDurationMs={setPauseDurationMs}
          />
          <TranscriptList
            cues={cues}
            activeIndex={activeIndex}
            autoScroll={autoScroll}
            onSelect={handleSelect}
          />
        </aside>
      </div>
    </div>
  )
}

type PracticeBarProps = {
  loopMode: LoopMode
  loopCount: number
  autoPlayOnJump: boolean
  pauseAfterLine: boolean
  pauseDurationMs: number
  onLoopMode: (mode: LoopMode) => void
  onLoopCount: (count: number) => void
  onAutoPlayOnJump: (value: boolean) => void
  onPauseAfterLine: (value: boolean) => void
  onPauseDurationMs: (value: number) => void
}

const LOOP_OPTIONS: Array<{ value: LoopMode; label: string; hint: string }> = [
  { value: 'off', label: 'Once', hint: 'Play straight through' },
  { value: 'sentence', label: 'Line', hint: 'Repeat the current line forever' },
  { value: 'sentence-n', label: '×N', hint: 'Repeat the current line a fixed number of times' },
]

function PracticeBar({
  loopMode,
  loopCount,
  autoPlayOnJump,
  pauseAfterLine,
  pauseDurationMs,
  onLoopMode,
  onLoopCount,
  onAutoPlayOnJump,
  onPauseAfterLine,
  onPauseDurationMs,
}: PracticeBarProps) {
  return (
    <div className="shrink-0 border-b border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">Repeat</span>
          <div className="flex overflow-hidden rounded-md border border-line-strong bg-surface">
            {LOOP_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                aria-pressed={loopMode === option.value}
                onClick={() => onLoopMode(option.value)}
                className={[
                  'px-2 py-1 text-[11px] transition-colors',
                  loopMode === option.value
                    ? 'bg-accent-strong font-medium text-white'
                    : 'bg-transparent text-ink-soft hover:bg-raised hover:text-ink',
                ].join(' ')}
              >
                {option.label}
              </button>
            ))}
          </div>
          {loopMode === 'sentence-n' ? (
            <input
              type="number"
              min={1}
              max={20}
              value={loopCount}
              onChange={(event) => onLoopCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
              aria-label="Repeat count"
              className="w-12 rounded-md border border-line-strong bg-sunken px-1.5 py-0.5 text-[11px] text-ink-soft outline-none focus:border-accent"
            />
          ) : null}
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={autoPlayOnJump}
            onChange={(event) => onAutoPlayOnJump(event.target.checked)}
            className="size-3.5 accent-accent"
          />
          Play on click
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={pauseAfterLine}
            onChange={(event) => onPauseAfterLine(event.target.checked)}
            className="size-3.5 accent-accent"
          />
          Pause after line
        </label>

        {pauseAfterLine ? (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <select
              value={pauseDurationMs}
              onChange={(event) => onPauseDurationMs(Number(event.target.value))}
              aria-label="Pause duration"
              className="rounded-md border border-line-strong bg-sunken px-1.5 py-0.5 text-[11px] text-ink-soft outline-none"
            >
              {[500, 1000, 1500, 2000, 3000, 5000].map((value) => (
                <option key={value} value={value}>
                  {value / 1000}s
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  )
}
