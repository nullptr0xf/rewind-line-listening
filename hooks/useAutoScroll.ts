'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Keeps the active line centered while playing — and gets out of the way the
 * moment the user starts scrolling.
 *
 * The "auto-scroll fights the user" bug is the classic way lyric-style players
 * become infuriating: you scroll back to re-read a line, and playback yanks you
 * forward again. So:
 *   - any real input (wheel / touch / keys / drag) takes ownership for a while
 *   - while the user owns the scroll we never touch scrollTop
 *   - a "back to current line" affordance appears instead
 *
 * The animation is hand-rolled rather than scrollTo({behavior:'smooth'}) so that
 * a new target mid-flight eases from wherever we actually are, instead of
 * restarting from a stale position and producing a visible stutter.
 */

const LOCK_DURATION_MS = 2500
const SCROLL_DURATION_MS = 300
const FOLLOW_TOLERANCE_PX = 4

export type AutoScroll = {
  containerRef: RefObject<HTMLDivElement | null>
  registerRow: (index: number, element: HTMLElement | null) => void
  scrollToIndex: (index: number, options?: { immediate?: boolean }) => void
  /** True while the user is browsing manually and auto-follow is suspended. */
  isUserBrowsing: boolean
  /** Hand control back to playback and jump to the active line. */
  resumeFollow: () => void
}

export function useAutoScroll(activeIndex: number): AutoScroll {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef(new Map<number, HTMLElement>())
  const rafRef = useRef(0)
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lockedRef = useRef(false)

  const [isUserBrowsing, setIsUserBrowsing] = useState(false)

  const cancelAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [])

  const centerOn = useCallback(
    (index: number, animated: boolean) => {
      const container = containerRef.current
      const row = rowsRef.current.get(index)
      if (!container || !row) return

      const containerRect = container.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const desired =
        container.scrollTop +
        (rowRect.top - containerRect.top) -
        container.clientHeight / 2 +
        rowRect.height / 2

      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const target = Math.min(maxTop, Math.max(0, desired))

      if (Math.abs(target - container.scrollTop) <= FOLLOW_TOLERANCE_PX) return

      cancelAnimation()

      if (!animated) {
        container.scrollTop = target
        return
      }

      const startTop = container.scrollTop
      const delta = target - startTop
      const startedAt = performance.now()

      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / SCROLL_DURATION_MS)
        const eased = 1 - (1 - progress) ** 3
        container.scrollTop = startTop + delta * eased
        if (progress < 1) {
          rafRef.current = requestAnimationFrame(step)
        } else {
          rafRef.current = 0
        }
      }

      rafRef.current = requestAnimationFrame(step)
    },
    [cancelAnimation],
  )

  const takeOver = useCallback(() => {
    cancelAnimation()
    lockedRef.current = true
    setIsUserBrowsing(true)
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current)
    lockTimerRef.current = setTimeout(() => {
      lockedRef.current = false
      setIsUserBrowsing(false)
      lockTimerRef.current = null
    }, LOCK_DURATION_MS)
  }, [cancelAnimation])

  const resumeFollow = useCallback(() => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
    lockedRef.current = false
    setIsUserBrowsing(false)
    if (activeIndex >= 0) centerOn(activeIndex, true)
  }, [activeIndex, centerOn])

  // Only genuine input events take ownership. Listening to 'scroll' would be
  // wrong here, because our own animation fires it too.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onWheel = () => takeOver()
    const onTouchMove = () => takeOver()
    const onPointerDown = () => takeOver()
    const onKeyDown = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key)) {
        takeOver()
      }
    }

    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    container.addEventListener('keydown', onKeyDown)

    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('keydown', onKeyDown)
    }
  }, [takeOver])

  useEffect(() => {
    if (lockedRef.current) return
    if (activeIndex < 0) return
    centerOn(activeIndex, true)
  }, [activeIndex, centerOn])

  useEffect(() => () => {
    cancelAnimation()
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current)
  }, [cancelAnimation])

  const registerRow = useCallback((index: number, element: HTMLElement | null) => {
    if (element) rowsRef.current.set(index, element)
    else rowsRef.current.delete(index)
  }, [])

  const scrollToIndex = useCallback(
    (index: number, options?: { immediate?: boolean }) => {
      centerOn(index, !options?.immediate)
    },
    [centerOn],
  )

  return { containerRef, registerRow, scrollToIndex, isUserBrowsing, resumeFollow }
}
