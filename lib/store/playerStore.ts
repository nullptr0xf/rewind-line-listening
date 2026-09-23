'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Player preferences. Kept deliberately small: everything that changes once per
 * frame lives in refs and DOM, never here.
 *
 * Hydration is skipped on purpose — the server renders defaults, then the
 * client rehydrates in an effect. That avoids a markup mismatch without having
 * to make the whole player dynamic.
 */

export type LoopMode = 'off' | 'sentence' | 'sentence-n'

export const PLAYBACK_RATES = [0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2] as const

type PlayerState = {
  rate: number
  volume: number
  muted: boolean
  loopMode: LoopMode
  /** How many times a line repeats in 'sentence-n' mode. */
  loopCount: number
  /** Start playing immediately when a line is clicked. */
  autoPlayOnJump: boolean
  /** Pause for a moment after each line, to leave room for shadowing. */
  pauseAfterLine: boolean
  pauseDurationMs: number
  setRate: (rate: number) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setLoopMode: (mode: LoopMode) => void
  setLoopCount: (count: number) => void
  setAutoPlayOnJump: (value: boolean) => void
  setPauseAfterLine: (value: boolean) => void
  setPauseDurationMs: (value: number) => void
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      rate: 1,
      volume: 1,
      muted: false,
      loopMode: 'off',
      loopCount: 3,
      autoPlayOnJump: true,
      pauseAfterLine: false,
      pauseDurationMs: 1500,
      setRate: (rate) => set({ rate }),
      setVolume: (volume) => set({ volume, muted: volume === 0 }),
      setMuted: (muted) => set({ muted }),
      setLoopMode: (loopMode) => set({ loopMode }),
      setLoopCount: (loopCount) => set({ loopCount }),
      setAutoPlayOnJump: (autoPlayOnJump) => set({ autoPlayOnJump }),
      setPauseAfterLine: (pauseAfterLine) => set({ pauseAfterLine }),
      setPauseDurationMs: (pauseDurationMs) => set({ pauseDurationMs }),
    }),
    {
      name: 'english-listening:player',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
    },
  ),
)
