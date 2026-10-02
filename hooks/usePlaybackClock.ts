'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { findActiveCueIndex } from '@/lib/sync/findActiveCue'
import type { Cue } from '@/lib/lesson/schema'

/**
 * The single clock of the player. Read this before touching anything that
 * animates with playback.
 *
 * THE RULE THAT MATTERS:
 * `currentTime` must never enter React state. Setting state 60 times a second
 * re-renders the whole transcript tree every frame and the UI dies on a
 * 1000-line transcript. So this hook splits the consumers in two:
 *
 *   1. per-frame consumers (progress bar, playhead, word highlighting)
 *      -> subscribe() and write to the DOM imperatively. React is not involved.
 *   2. the "which line is active" consumer
 *      -> this DOES go through React state, but it only changes once every few
 *         seconds, so the render rate collapses from ~60 Hz to ~0.5 Hz.
 *
 * Frame source: requestVideoFrameCallback when available *and* the element
 * actually has a picture — rvfc fires per presented frame, carries an accurate
 * mediaTime, and stops by itself while paused, but for an audio-only file it
 * never fires at all, which freezes the clock. Those fall back to
 * requestAnimationFrame.
 *
 * This is a pure function of the available APIs. For testable logic see
 * lib/sync/findActiveCue.ts.
 */

export type FrameListener = (timeMs: number) => void

export type PlaybackClock = {
  /** Register a per-frame callback. Returns an unsubscribe function. */
  subscribe: (listener: FrameListener) => () => void
  /** Latest known playback position in milliseconds. Safe to read any time. */
  getTimeMs: () => number
  /** Index of the highlighted cue, or -1 when we are in a gap. */
  activeIndex: number
  /** Ask for an immediate re-read (after a programmatic seek). */
  requestSync: () => void
}

export function usePlaybackClock(
  videoRef: RefObject<HTMLVideoElement | null>,
  cues: readonly Cue[],
): PlaybackClock {
  const [activeIndex, setActiveIndex] = useState(-1)

  const listenersRef = useRef(new Set<FrameListener>())
  const timeMsRef = useRef(0)
  const cuesRef = useRef<readonly Cue[]>(cues)
  const activeIndexRef = useRef(-1)

  // Keep the latest cues reachable from inside the animation loop without
  // re-creating the loop on every render.
  useEffect(() => {
    cuesRef.current = cues
    // Cues changed (transcript loaded or edited): recompute immediately.
    const next = findActiveCueIndex(cues, timeMsRef.current)
    if (next !== activeIndexRef.current) {
      activeIndexRef.current = next
      setActiveIndex(next)
    }
  }, [cues])

  const emit = useCallback((timeMs: number) => {
    if (!Number.isFinite(timeMs)) return
    timeMsRef.current = timeMs

    for (const listener of listenersRef.current) listener(timeMs)

    const next = findActiveCueIndex(cuesRef.current, timeMs)
    if (next !== activeIndexRef.current) {
      activeIndexRef.current = next
      setActiveIndex(next)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let stopped = false
    let rafId = 0
    let rvfcId = 0
    const supportsRvfc = typeof video.requestVideoFrameCallback === 'function'

    const stopLoop = () => {
      if (rvfcId) {
        video.cancelVideoFrameCallback?.(rvfcId)
        rvfcId = 0
      }
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const pumpFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (stopped) return
      emit(metadata.mediaTime * 1000)
      rvfcId = video.requestVideoFrameCallback(pumpFrame)
    }

    const pumpRaf = () => {
      if (stopped) return
      emit(video.currentTime * 1000)
      rafId = requestAnimationFrame(pumpRaf)
    }

    const startLoop = () => {
      if (stopped) return
      stopLoop()
      // rvfc fires per *presented video frame*. An audio-only file (m4a / mp3 /
      // wav) never presents one, so with rvfc the clock freezes at the last
      // seek and the transcript never advances while audio plays. Probe the
      // element, not the capability: re-evaluated on every play / ratechange,
      // so a file that gains its picture after metadata arrives recovers on
      // the next play event.
      if (supportsRvfc && video.videoWidth > 0) rvfcId = video.requestVideoFrameCallback(pumpFrame)
      else rafId = requestAnimationFrame(pumpRaf)
    }

    const syncNow = () => {
      if (stopped) return
      emit(video.currentTime * 1000)
    }

    // After a seek the frame callback may not fire for a moment, and while
    // paused it never fires at all. Settle the position over two frames.
    const settle = () => {
      syncNow()
      requestAnimationFrame(syncNow)
    }

    const onPlay = () => startLoop()
    const onPause = () => {
      stopLoop()
      syncNow()
    }
    const onSeeked = () => settle()
    const onLoaded = () => settle()
    const onRateChange = () => {
      if (!video.paused) startLoop()
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('playing', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onPause)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('durationchange', onLoaded)
    video.addEventListener('ratechange', onRateChange)

    settle()
    if (!video.paused) startLoop()

    return () => {
      stopped = true
      stopLoop()
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onPause)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('durationchange', onLoaded)
      video.removeEventListener('ratechange', onRateChange)
    }
  }, [videoRef, emit])

  const subscribe = useCallback((listener: FrameListener) => {
    listenersRef.current.add(listener)
    listener(timeMsRef.current)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const getTimeMs = useCallback(() => timeMsRef.current, [])

  const requestSync = useCallback(() => {
    const video = videoRef.current
    // Test for the element, not for a truthy number: a seek to exactly 0 is a
    // valid position, and `currentTime ? ... : ...` would report the stale one.
    emit(video ? video.currentTime * 1000 : timeMsRef.current)
  }, [videoRef, emit])

  return { subscribe, getTimeMs, activeIndex, requestSync }
}
