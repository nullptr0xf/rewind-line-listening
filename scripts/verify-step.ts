/**
 * Do the arrow keys / line buttons actually walk the transcript one line at a
 * time? Run with `npm run verify:step`.
 *
 * Why this is not just the unit test: `lib/sync/findActiveCue.test.ts` uses
 * three synthetic cues. The bug it guards against was *position dependent* —
 * "previous line" returned the current line whenever the playhead was more
 * than 400ms into it, so mid-line the key silently did nothing and only the
 * first 400ms of a line behaved. That needs realistic line lengths, so this
 * sweeps the real fixture transcript at eight depths inside every line.
 *
 * It also re-runs the same sweep against the old rule as a control. A check
 * that passes for both the buggy and the fixed implementation proves nothing;
 * the control is what makes the pass meaningful.
 *
 * No playback involved — this drives the same pure lookups the player calls,
 * including the 5ms landing offset WatchScreen uses when it seeks.
 */
import fs from 'node:fs'
import path from 'node:path'

import { parseSubtitleText } from '@/lib/lesson/vtt'
import { findNextCueIndex, findPreviousCueIndex } from '@/lib/sync/findActiveCue'

/** WatchScreen.handleSelect lands 5ms into the line, not on its start. */
const LAND = 5
const FIXTURE = 'testmedia/listening-fixture-01.vtt'

const fixturePath = path.join(process.cwd(), FIXTURE)
if (!fs.existsSync(fixturePath)) {
  console.error(`Missing ${FIXTURE}. Run: npm run fixture`)
  process.exit(1)
}

const { cues } = parseSubtitleText(fs.readFileSync(fixturePath, 'utf8'))
if (cues.length < 3) {
  console.error(`${FIXTURE} has ${cues.length} lines; need at least 3 to step through.`)
  process.exit(1)
}

console.log(`fixture: ${cues.length} lines, ${(cues[cues.length - 1].end / 1000).toFixed(1)}s`)

let failures = 0
const fail = (message: string) => {
  failures += 1
  console.log(`  FAIL ${message}`)
}

/** Walk by pressing one key repeatedly from a starting line. */
function walk(from: number, direction: 1 | -1, presses: number): number[] {
  const visited: number[] = []
  let timeMs = cues[from].start + LAND
  let index = from
  for (let i = 0; i < presses; i += 1) {
    index =
      direction === 1 ? findNextCueIndex(cues, timeMs) : findPreviousCueIndex(cues, timeMs)
    timeMs = cues[index].start + LAND
    visited.push(index)
  }
  return visited
}

// 1. Forward from the first line visits 1,2,3,... with no repeats or stalls.
{
  const visited = walk(0, 1, cues.length - 1)
  const expected = cues.slice(1).map((_, i) => i + 1)
  if (visited.join(',') !== expected.join(',')) {
    fail(`forward walk was ${visited.join(',')} expected ${expected.join(',')}`)
  }
}

// 2. Backward from the last line visits n-2,n-3,...,0.
{
  const last = cues.length - 1
  const visited = walk(last, -1, last)
  const expected = cues.slice(0, last).map((_, i) => last - 1 - i)
  if (visited.join(',') !== expected.join(',')) {
    fail(`backward walk was ${visited.join(',')} expected ${expected.join(',')}`)
  }
}

/**
 * Offsets must stay inside the line: cues here are back-to-back (each end is
 * the next start), so a fixed +3000ms often lands two lines further on. A
 * first version of this check did exactly that and reported nine false
 * failures — the harness was wrong, not the function.
 */
const DEPTHS = [0, 1, 100, 400, 401, 1000, 3000]
function offsetSweep(previous: (timeMs: number) => number): { checked: number; wrong: number } {
  let checked = 0
  let wrong = 0
  for (let i = 1; i < cues.length; i += 1) {
    const span = cues[i].end - cues[i].start
    for (const offset of [...DEPTHS, span - 1]) {
      if (offset < 0 || offset >= span) continue
      checked += 1
      if (previous(cues[i].start + offset) !== i - 1) wrong += 1
    }
  }
  return { checked, wrong }
}

// 3. However deep into a line the playhead is, ← moves up exactly one line.
{
  const { checked, wrong } = offsetSweep((timeMs) => findPreviousCueIndex(cues, timeMs))
  console.log(`  checked ${checked} in-line offsets`)
  if (wrong > 0) fail(`${wrong} of ${checked} in-line offsets did not step back one line`)
}

// 4. Round trip: → then ← returns to the line we left.
{
  for (let i = 0; i < cues.length - 1; i += 1) {
    const from = cues[i].start + Math.floor((cues[i].end - cues[i].start) / 2)
    const next = findNextCueIndex(cues, from)
    const back = findPreviousCueIndex(cues, cues[next].start + LAND)
    if (back !== i) fail(`from line ${i}: -> ${next} then <- ${back}, wanted ${i}`)
  }
}

// 5. Pressing ← on the first line stays put rather than going negative.
{
  if (findPreviousCueIndex(cues, cues[0].start + 500) !== 0) fail('← on line 0 did not clamp')
  if (findPreviousCueIndex(cues, 0) !== 0) fail('← before the transcript did not clamp')
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)

// Control: re-run the sweep against the old rule, so a green run means the
// check discriminates. Measured 131/271 wrong when the fix landed.
{
  const oldPrevious = (timeMs: number): number => {
    const index = cues.findLastIndex((cue) => cue.start <= timeMs)
    if (index <= 0) return 0
    return timeMs - cues[index].start > 400 ? index : index - 1
  }
  const { checked, wrong } = offsetSweep(oldPrevious)
  console.log(`control: the old rule gets ${wrong}/${checked} of the same offsets wrong`)
}

process.exit(failures === 0 ? 0 : 1)
