'use client'

import { CueRow } from './CueRow'
import type { Cue } from '@/lib/lesson/schema'
import type { AutoScroll } from '@/hooks/useAutoScroll'

/**
 * The scrolling transcript.
 *
 * DEVIATION from the design doc, deliberately: there is no virtualiser yet.
 * The doc calls for TanStack Virtual, and that is still the plan for M2 — but it
 * interacts badly with the other two requirements here. Lines have variable
 * heights (sentences wrap), and "scroll the active line to the exact centre"
 * needs real measured offsets; with estimated row heights the list visibly
 * jumps while playing. Since only the active row pair re-renders (see CueRow's
 * memo), a 1000-line transcript of plain text stays responsive without it.
 *
 * Revisit in M2 with `measureElement` once the panel's feel is settled.
 */

type TranscriptListProps = {
  cues: readonly Cue[]
  activeIndex: number
  autoScroll: AutoScroll
  onSelect: (index: number) => void
}

export function TranscriptList({ cues, activeIndex, autoScroll, onSelect }: TranscriptListProps) {
  const { containerRef, registerRow, isUserBrowsing, resumeFollow } = autoScroll

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        tabIndex={0}
        className="scroll-thin h-full overflow-y-auto overscroll-contain outline-none"
      >
        {cues.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink-200">No transcript yet</p>
            <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-ink-500">
              This lesson has no lines. Put a matching <code className="text-ink-300">.srt</code> or{' '}
              <code className="text-ink-300">.vtt</code> file next to the video and import it again,
              or transcribe it in M1.
            </p>
          </div>
        ) : (
          <div className="py-2">
            {cues.map((cue, index) => (
              <CueRow
                key={cue.id}
                cue={cue}
                index={index}
                isActive={index === activeIndex}
                onSelect={onSelect}
                onRegister={registerRow}
              />
            ))}
          </div>
        )}
      </div>

      {isUserBrowsing && activeIndex >= 0 ? (
        <button
          type="button"
          onClick={resumeFollow}
          className="animate-cue-pop absolute bottom-4 left-1/2 rounded-full border border-ink-600 bg-ink-800 px-3 py-1.5 text-[11px] font-medium text-ink-200 shadow-lg transition-colors hover:border-ink-500 hover:text-ink-100"
        >
          Back to current line
        </button>
      ) : null}
    </div>
  )
}
