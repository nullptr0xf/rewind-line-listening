'use client'

import type { RefObject } from 'react'

type VideoPaneProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  src: string
  /** Shown instead of the video when the source file cannot be reached. */
  missingSince?: string | null
  onLoadedMetadata?: () => void
  onError?: () => void
}

/**
 * The <video> element and nothing else.
 *
 * Note what is NOT here: no `timeupdate` listener, no state that updates with
 * playback. The element is driven imperatively by WatchScreen and read by
 * usePlaybackClock. Also no `<track>`: our transcript panel is the subtitle
 * renderer, because rendering the text ourselves is what makes it clickable.
 */
export function VideoPane({
  videoRef,
  src,
  missingSince,
  onLoadedMetadata,
  onError,
}: VideoPaneProps) {
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        playsInline
        className="max-h-full max-w-full"
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
      />

      {missingSince ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/85 px-8 text-center">
          <p className="text-sm font-medium text-ink-100">Source file not reachable</p>
          <p className="max-w-md text-xs text-ink-400">
            Your transcript and progress are safe — nothing was deleted. Move the file back, or
            re-import it from its new location and this lesson will be re-pointed to it.
          </p>
        </div>
      ) : null}
    </div>
  )
}
