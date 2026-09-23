'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { formatClock } from '@/lib/lesson/vtt'
import { PLAYBACK_RATES, usePlayerStore } from '@/lib/store/playerStore'
import type { PlaybackClock } from '@/hooks/usePlaybackClock'

/**
 * Transport controls.
 *
 * The playhead is written straight to the DOM from the frame clock (see the
 * comment in usePlaybackClock). React state here changes only when the play
 * state or the duration changes — i.e. essentially never.
 */

const SEEK_STEP_MS = 5000

type ControlBarProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  clock: PlaybackClock
  fullscreenContainerRef: RefObject<HTMLDivElement | null>
  onPreviousLine: () => void
  onNextLine: () => void
}

function IconButton({
  onClick,
  label,
  children,
  disabled,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="inline-flex size-8 items-center justify-center rounded-md text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

export function ControlBar({
  videoRef,
  clock,
  fullscreenContainerRef,
  onPreviousLine,
  onNextLine,
}: ControlBarProps) {
  const rate = usePlayerStore((state) => state.rate)
  const setRate = usePlayerStore((state) => state.setRate)
  const volume = usePlayerStore((state) => state.volume)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const muted = usePlayerStore((state) => state.muted)
  const setMuted = usePlayerStore((state) => state.setMuted)

  const [isPlaying, setIsPlaying] = useState(false)
  const [durationMs, setDurationMs] = useState(0)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const fillRef = useRef<HTMLDivElement | null>(null)
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const currentLabelRef = useRef<HTMLSpanElement | null>(null)
  const scrubbingRef = useRef(false)
  const lastShownSecondRef = useRef(-1)

  const paint = useCallback((timeMs: number) => {
    const duration = videoRef.current?.duration ?? 0
    const ratio = duration > 0 ? Math.min(1, Math.max(0, timeMs / (duration * 1000))) : 0
    if (fillRef.current) fillRef.current.style.width = `${ratio * 100}%`
    if (thumbRef.current) thumbRef.current.style.left = `${ratio * 100}%`

    const seconds = Math.floor(timeMs / 1000)
    if (seconds !== lastShownSecondRef.current && currentLabelRef.current) {
      lastShownSecondRef.current = seconds
      currentLabelRef.current.textContent = formatClock(timeMs)
    }
  }, [videoRef])

  useEffect(() => {
    return clock.subscribe((timeMs) => {
      if (scrubbingRef.current) return
      paint(timeMs)
    })
  }, [clock, paint])

  // Play state + duration are the only two things worth re-rendering for.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onMeta = () => setDurationMs((video.duration || 0) * 1000)

    setIsPlaying(!video.paused)
    onMeta()

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('durationchange', onMeta)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('durationchange', onMeta)
    }
  }, [videoRef])

  // Rate and volume; keep the pitch intact so slow playback does not turn into
  // a demon voice.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const withPitch = video as HTMLVideoElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean }
    if ('preservesPitch' in video) withPitch.preservesPitch = true
    if ('webkitPreservesPitch' in video) withPitch.webkitPreservesPitch = true
    video.playbackRate = rate
  }, [videoRef, rate])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
  }, [videoRef, volume, muted])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }, [videoRef])

  const seekBy = useCallback(
    (deltaMs: number) => {
      const video = videoRef.current
      if (!video) return
      const next = Math.max(0, Math.min(video.duration || 0, video.currentTime + deltaMs / 1000))
      video.currentTime = next
    },
    [videoRef],
  )

  const timeFromClientX = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current
      const video = videoRef.current
      if (!track || !video || !video.duration) return null
      const rect = track.getBoundingClientRect()
      if (rect.width === 0) return null
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * video.duration * 1000
    },
    [videoRef],
  )

  const onTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const video = videoRef.current
      const timeMs = timeFromClientX(event.clientX)
      if (!video || timeMs === null) return
      event.currentTarget.setPointerCapture(event.pointerId)
      scrubbingRef.current = true
      paint(timeMs)
      video.currentTime = timeMs / 1000
    },
    [paint, timeFromClientX, videoRef],
  )

  const onTrackPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbingRef.current) return
      const timeMs = timeFromClientX(event.clientX)
      if (timeMs === null) return
      paint(timeMs)
    },
    [paint, timeFromClientX],
  )

  const onTrackPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scrubbingRef.current) return
      scrubbingRef.current = false
      event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [],
  )

  const toggleFullscreen = useCallback(() => {
    const container = fullscreenContainerRef.current
    if (!container) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.requestFullscreen()
  }, [fullscreenContainerRef])

  return (
    <div className="border-t border-ink-800 bg-ink-900 px-3 py-2">
      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        className="group relative -mx-1 cursor-pointer px-1 py-2"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={0}
      >
        <div className="h-1 w-full rounded-full bg-ink-700">
          <div ref={fillRef} className="h-1 rounded-full bg-accent-500" style={{ width: '0%' }} />
        </div>
        <div
          ref={thumbRef}
          className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-400 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ left: '0%' }}
        />
      </div>

      <div className="mt-0.5 flex items-center gap-1">
        <IconButton onClick={togglePlay} label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? (
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
              <rect x="3" y="2" width="3.5" height="12" rx="1" />
              <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
              <path d="M4 2.6c0-.8.9-1.3 1.6-.9l7 5.4c.6.4.6 1.4 0 1.8l-7 5.4c-.7.4-1.6-.1-1.6-.9V2.6Z" />
            </svg>
          )}
        </IconButton>

        <IconButton onClick={() => seekBy(-SEEK_STEP_MS)} label="Back 5 seconds">
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M7 3.5 3.5 6.5 7 9.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3.8 6.5h5.4a3.6 3.6 0 1 1 0 7.2" strokeLinecap="round" />
          </svg>
        </IconButton>

        <IconButton onClick={() => seekBy(SEEK_STEP_MS)} label="Forward 5 seconds">
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 3.5 12.5 6.5 9 9.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12.2 6.5H6.8a3.6 3.6 0 1 0 0 7.2" strokeLinecap="round" />
          </svg>
        </IconButton>

        <IconButton onClick={onPreviousLine} label="Previous line">
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 3v10M12 4.2v7.6L6.5 8 12 4.2Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>

        <IconButton onClick={onNextLine} label="Next line">
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 3v10M4 4.2v7.6L9.5 8 4 4.2Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconButton>

        <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-300">
          <span ref={currentLabelRef}>00:00</span>
          <span className="text-ink-500"> / {formatClock(durationMs)}</span>
        </span>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-ink-400">
            <span className="sr-only">Playback speed</span>
            <select
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
              className="rounded-md border border-ink-700 bg-ink-850 px-1.5 py-1 text-[11px] text-ink-200 outline-none hover:border-ink-600"
            >
              {PLAYBACK_RATES.map((value) => (
                <option key={value} value={value}>
                  {value}x
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1">
            <IconButton onClick={() => setMuted(!muted)} label={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? (
                <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
                  <path d="M8 3.2 5.2 5.5H3.2c-.5 0-.9.4-.9.9v3.2c0 .5.4.9.9.9h2L8 12.8V3.2Z" />
                  <path d="M10.6 6.2 13.4 9.8M13.4 6.2l-2.8 3.6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
                  <path d="M8 3.2 5.2 5.5H3.2c-.5 0-.9.4-.9.9v3.2c0 .5.4.9.9.9h2L8 12.8V3.2Z" />
                  <path d="M10.4 5.8a3 3 0 0 1 0 4.4M12.2 4a5.4 5.4 0 0 1 0 8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                </svg>
              )}
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Volume"
              className="h-1 w-20 accent-accent-500"
            />
          </div>

          <IconButton onClick={toggleFullscreen} label="Fullscreen">
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 3H3v3M10 3h3v3M10 13h3v-3M6 13H3v-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        </div>
      </div>
    </div>
  )
}
