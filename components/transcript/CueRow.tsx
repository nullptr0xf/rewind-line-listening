'use client'

import { memo } from 'react'
import type { Cue } from '@/lib/lesson/schema'
import { formatClock } from '@/lib/lesson/vtt'

/**
 * One line of the transcript.
 *
 * Memoised on purpose. The parent re-renders when the active line changes, and
 * with a 1000-line transcript an un-memoised row would re-render the entire
 * list every few seconds. With memo only the line leaving focus and the line
 * entering focus actually update.
 */

export type CueRowProps = {
  cue: Cue
  index: number
  isActive: boolean
  onSelect: (index: number) => void
  onRegister: (index: number, element: HTMLElement | null) => void
}

function CueRowComponent({ cue, index, isActive, onSelect, onRegister }: CueRowProps) {
  return (
    <div
      ref={(element) => onRegister(index, element)}
      onClick={() => onSelect(index)}
      data-active={isActive ? 'true' : undefined}
      className={[
        'group relative flex cursor-pointer gap-3 border-l-2 py-2 pl-3 pr-4 transition-colors',
        isActive
          ? 'border-accent-500 bg-ink-800'
          : 'border-transparent hover:border-ink-600 hover:bg-ink-850',
      ].join(' ')}
    >
      <span
        className={[
          'mt-[3px] w-11 shrink-0 select-none font-mono text-[11px] tabular-nums',
          isActive ? 'text-accent-400' : 'text-ink-500 group-hover:text-ink-400',
        ].join(' ')}
      >
        {formatClock(cue.start)}
      </span>

      <p
        className={[
          'flex-1 text-[15px] leading-relaxed',
          isActive ? 'text-ink-100' : 'text-ink-400 group-hover:text-ink-200',
        ].join(' ')}
      >
        {cue.text}
      </p>
    </div>
  )
}

export const CueRow = memo(CueRowComponent)
