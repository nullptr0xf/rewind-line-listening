'use client'

import { useCallback, useEffect, useState, type RefObject } from 'react'

type VideoPaneProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  src: string
  /** Shown on the audio-only face. */
  title?: string
  /** Shown instead of the video when the source file cannot be reached. */
  missingSince?: string | null
  onLoadedMetadata?: () => void
  onError?: () => void
}

/**
 * The stage: the <video> element, plus whatever has to be drawn when it cannot
 * draw itself.
 *
 * Still no `timeupdate` listener and still no state that changes with playback —
 * the element is driven imperatively by WatchScreen and read by
 * usePlaybackClock (invariant #4). The one piece of state here is `phase`, which
 * changes at most twice per lesson. Also no `<track>`: our transcript panel is
 * the subtitle renderer, because rendering the text ourselves is what makes it
 * clickable.
 *
 * `phase` exists because "no picture" has more than one cause and they deserve
 * different faces. A stage that leaves a bare element on a bare background shows
 * the same black rectangle for all of them, which is what this replaces.
 */
type Phase = 'loading' | 'picture' | 'audio'

export function VideoPane({
  videoRef,
  src,
  title,
  missingSince,
  onLoadedMetadata,
  onError,
}: VideoPaneProps) {
  const [phase, setPhase] = useState<Phase>('loading')

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    // `videoWidth` is 0 for an audio-only file (mp3 / m4a / wav), and that is
    // otherwise indistinguishable from "not loaded yet" — so the decision is
    // made here, from the element, rather than from ffprobe in the parent. It
    // also means a lesson imported before this existed gets the right face on
    // its next load, with no re-import.
    if (video) setPhase(video.videoWidth > 0 ? 'picture' : 'audio')
    onLoadedMetadata?.()
  }, [onLoadedMetadata, videoRef])

  // A lesson can be re-pointed at a different file. Reset so the previous
  // file's face does not linger over the new one.
  useEffect(() => {
    setPhase('loading')
  }, [src])

  // `preload="metadata"` against a local file can resolve before React attaches
  // its handler, in which case `loadedmetadata` is missed and we would sit on
  // the loading face for good. Catch that case on mount.
  useEffect(() => {
    const video = videoRef.current
    // readyState >= HAVE_METADATA
    if (video && video.readyState >= 1) handleLoadedMetadata()
  }, [handleLoadedMetadata, videoRef])

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-sunken p-3 fullscreen:p-0">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        className="max-h-full max-w-full rounded-lg shadow-xl shadow-ink/10 ring-1 ring-line-strong/60 fullscreen:rounded-none fullscreen:shadow-none fullscreen:ring-0"
        onLoadedMetadata={handleLoadedMetadata}
        onError={onError}
      />

      {phase === 'loading' && !missingSince ? <LoadingFace /> : null}
      {phase === 'audio' && !missingSince ? <AudioFace title={title} /> : null}

      {missingSince ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/95 px-8 text-center backdrop-blur-sm">
          <p className="text-sm font-medium text-ink">Source file not reachable</p>
          <p className="max-w-md text-xs leading-relaxed text-ink-muted">
            Your transcript and progress are safe — nothing was deleted. Move the file back, or
            re-import it from its new location and this lesson will be re-pointed to it.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Between "the element exists" and "there is a frame". Deliberately plain: on a
 * local file this lasts one or two frames, so anything elaborate here is a flash
 * of noise rather than a loading state.
 */
function LoadingFace() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-sunken">
      <span
        aria-hidden
        className="size-5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      <p className="text-xs text-ink-muted">Loading picture…</p>
    </div>
  )
}

/**
 * An audio-only lesson. This is a real case rather than a hypothetical: the
 * import panel accepts mp3 / m4a / wav, and every one of those used to render as
 * a blank black rectangle with no explanation at all.
 *
 * The glyph breathes, it does not meter — see the note on `audio-breathe` in
 * globals.css for why it is deliberately not a level meter.
 */
function AudioFace({ title }: { title?: string }) {
  const bars: Array<[number, number]> = [
    [4, 10], [16, 22], [28, 34], [40, 46], [52, 54],
    [64, 46], [76, 34], [88, 22], [100, 10],
  ]

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-gradient-to-br from-accent-wash via-surface to-sunken px-10 text-center">
      <svg
        aria-hidden
        viewBox="0 0 111 64"
        className="animate-audio-breathe h-16 w-32 text-accent"
        fill="currentColor"
      >
        {bars.map(([x, half]) => (
          <rect key={x} x={x} y={32 - half} width="7" height={half * 2} rx="3.5" opacity="0.55" />
        ))}
      </svg>

      <div>
        <p className="text-sm font-medium text-ink">{title ?? 'Audio only'}</p>
        <p className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-ink-muted">
          This file has no picture. Playback and the transcript work exactly the same — click a
          line to jump to it.
        </p>
      </div>
    </div>
  )
}
