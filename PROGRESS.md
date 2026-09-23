# PROGRESS

Status log for the English Listening project. Read this first — it is written so
that a fresh session with no context can pick the work up.

Last updated: 2026-09-23 (M0 complete, M1 not started)

---

## 1. What this is

A local, single-user English listening trainer. A video becomes a per-sentence
transcript you can click, loop and sit on — like lyric scrolling, but the lyrics
are sentences and clicking one seeks the video to it.

- **Design document (read it before changing anything):**
  `../docs/listening-app-design.md` — 17 sections of product + technical reasoning.
  It lives *outside* this project folder, one level up.
- **This folder** is the implementation. Everything below describes where the
  implementation deliberately matches the design doc, and where it deviates.

## 2. Run it

```bash
npm install
npm run tools:install    # stages ffmpeg + ffprobe into ./tools (from the npm registry)
npm run fixture          # generates testmedia/listening-fixture-01.{mp4,vtt}
npm run dev              # http://127.0.0.1:4317
```

Other commands:

```bash
npm run ingest -- "<path to a video>"     # import from the command line
npm run ingest -- --list                  # show the library
npm run ingest -- "<folder>"              # list candidates; imports nothing until --all / --only 1,3
npm test                                  # 59 unit tests over the pure modules
npm run typecheck
npm run build
```

The server binds `127.0.0.1` **only** — see §5. It is deliberately not reachable
from the LAN.

## 3. Current state

### Working end to end

| Area | State |
|---|---|
| Import by path (HTTP + CLI) | works, shares one pipeline |
| Native OS file dialog ("Browse…") | implemented, **not yet exercised** — see §7 |
| ffprobe metadata probe | works (reads `tools/ffprobe.exe`) |
| Sidecar `.vtt` / `.srt` discovery + parsing | works |
| Content fingerprint, re-import dedupe, re-point on move/rename | works |
| library list / remove (never touches the source file) | works |
| `GET /api/media/<id>` byte-range streaming | verified: 200 / 206 / 416 all correct |
| Player: play, pause, ±5s, prev/next line, scrub, rate, volume, fullscreen | implemented |
| Transcript: click to seek, sync highlight, auto-scroll + scroll lock | implemented, **needs a human eye** — see §7 |
| Repeat line / repeat ×N / pause after line | implemented |
| Progress memory (resume where you left off) | implemented |
| Unit tests over the pure modules | 59 passing — see §11 |

### Deliberately NOT implemented yet

- **ASR of any kind.** That is M1. `bin/ingest.ts` reports "no transcript yet"
  for a file with no subtitle, which is the correct M0 behaviour.
- **Upload / drag-and-drop import.** The design doc lists it as entry point #2
  and explicitly as the fallback, because a browser cannot hand us a real
  filesystem path. Only entry #1 (path) and #3 (CLI) exist. Deferred.
- **Embedded subtitle extraction** from the container. Detected and reported,
  not extracted.
- **Keyboard shortcuts.** The user deferred these ("暂时不用，可以后面配置").
  `ControlBar` has no key handling at all — this is intentional, not an oversight.
- **Favourites, translation, word-level highlighting, subtitle editor.** M2/M3+.
- **Virtualised transcript list.** See §6 — this is the one real deviation.

## 4. Architecture invariants

These are load-bearing. Breaking one reintroduces a bug the design doc spends
several sections avoiding.

1. **One ingest pipeline.** `lib/server/ingest.ts` is the only code path that
   brings a file into the app. The HTTP route and `bin/ingest.ts` both call
   `ingestFile()`. Never add a second path.
2. **`lib/server/**` must not import `next/*`.** The CLI runs these modules in a
   plain Node process. `NextRequest`, `cookies()`, `headers()` etc. would break
   it. `lib/server/ingest.ts`, `probe.ts`, `path.ts`, `repo.ts`, `db.ts`,
   `config.ts` are all pure Node.
3. **Everything downstream of import works on an absolute path.** Nothing
   downstream knows what an "upload" is.
4. **`currentTime` never enters React state.** Per-frame consumers
   (`ControlBar`'s playhead) subscribe to the clock and write to the DOM.
   Only the active line index is state. See `hooks/usePlaybackClock.ts`.
5. **Time is integer milliseconds everywhere.** Seconds only exist at the UI
   and export boundary. See `lib/lesson/schema.ts`.
6. **Nothing ever deletes a user's file.** `removeLesson()` deletes our index
   row and `data/lessons/<id>/`, and only deletes media it copied itself
   (`managed === 1`). The discard case does not exist in this codebase.
7. **The app only listens on `127.0.0.1`.** The ingest API can read any path the
   user can read, so exposing it to the LAN would be a file-disclosure hole.

## 5. Privacy / safety posture

- The ingest API accepts arbitrary absolute paths ⇒ it is equivalent to "read any
  file on this machine". Acceptable for a single-user localhost tool, and the
  reason the server binds loopback only and there is no LAN/mobile mode.
- `ingest.config.json` has an optional `allowedRoots` allowlist (empty =
  unrestricted). Fill it in if you ever want to tighten this.
- Removing a lesson from the library never deletes the source file. The UI
  confirm dialog says so explicitly.

## 6. Deviations from the design doc

| Design doc says | What was built | Why |
|---|---|---|
| Virtualise the transcript with TanStack Virtual | Renders all rows, but rows are `memo`ised so only the active pair re-renders | Variable-height rows (sentences wrap) + "centre the active line exactly" needs real measured offsets; with estimated heights the list jumps while playing. With memo, 1000 plain-text rows stay responsive. Revisit in M2 with `measureElement`. `@tanstack/react-virtual` is installed and unused. |
| Upload / drag-drop as import entry point #2 | Not built | Marked as the fallback in the doc itself. A browser cannot supply the absolute path the pipeline runs on, so this entry point only ever existed for convenience. |
| shadcn/ui for components | Hand-written Tailwind components | M0 only needs buttons, a select and a range input. Pulling in Radix now would add surface area without buying anything. Add it when dialogs/menus actually appear (M3 editor). |
| ffmpeg/ffprobe downloaded from gyan.dev | Staged from the npm registry into `tools/` by `npm run tools:install` | This machine cannot reach the usual mirrors. Same binaries, reproducible install, and now version-pinned in `package.json`. Note the vendored ffmpeg is a 2018 build (it has libx264, which is all the fixture generator needs). |
| Test material = an open movie (Sintel / Tears of Steel) | Synthesised fixture: eSpeak NG speech + ffmpeg `testsrc` | `download.blender.org` is behind a Cloudflare challenge and GitHub is unreachable here. The synthetic fixture is also a *stronger* test — see `testmedia/README.md`. |
| `lesson.json` field `video.duration` (seconds) | `video.durationMs` | Consistency: the whole codebase speaks milliseconds (invariant #5). |

## 7. Not yet verified — do this next

1. **The native file dialog** (`POST /api/ingest/pick`). It spawns PowerShell +
   `System.Windows.Forms.OpenFileDialog`, which blocks until the dialog closes.
   Nothing has opened it yet. If it misbehaves, the paste-a-path input is the
   fallback and works today.
2. **Player feel, by a human.** Range maths and SSR output are verified by
   request, but nobody has watched the highlight track the audio, dragged the
   scrubber, or sat on a loop. This is M0's actual acceptance criterion:
   *"listen for 20 minutes without wanting to stop"*.
3. **Two behaviours that only show up under a real hand:**
   - scroll lock: scroll away mid-playback, confirm the follow stops and the
     "Back to current line" button appears
   - loop edge: "Repeat line" at 0.7x on a short line (fixture line 12 is the
     shortest at 2.7s) — confirm it does not stutter or double-trigger

## 8. Environment notes for this machine

These cost real time to discover. Do not rediscover them.

- **The shell has a near-empty PATH.** `ls`, `head`, `tr`, `seq`, `sed` are
  frequently *not* available, and `dirname` never is. Prefer the Read/Write/Glob/
  Grep tools, or drive everything through Node with an absolute path:
  `D:\MyConfiguration\TCLXUSER\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`
- **npm is proxied** to `http://nexus.17usoft.com/repository/npm-all/`. The
  public registry is reachable too. GitHub raw and `download.blender.org` are not.
- **The PowerShell tool blocks `Add-Type` and COM instantiation.** That rules out
  `System.Speech` TTS and `SAPI.SpVoice`. Hence eSpeak NG (WASM) for test audio.
- **No system ffmpeg.** `npm run tools:install` vendors it into `tools/`.
- **`npm` itself does not run in the agent's shell** — npm is a shell script that
  needs a working `bash`, and this shell's PATH breaks it (`/usr/bin/env: 'bash':
  No such file or directory`). In a normal terminal `npm test` / `npm run dev`
  are fine. When working from the agent shell, call the underlying binaries
  directly instead:
  ```bash
  node node_modules/vitest/vitest.mjs run        # instead of npm test
  node node_modules/typescript/bin/tsc --noEmit  # instead of npm run typecheck
  ```
  `git` does work in that shell.
- `npm install` on a cold cache took ~8 minutes here. Be patient, don't re-run it.

## 9. Next: M1

Plan (design doc §16). Do these in order:

**Step 0 — a real acceptance gate.** Get whisper.cpp running with the Vulkan
backend on this machine's Intel Arc 140T and confirm it transcribes the fixture
faster than real time. If this fails, the whole M1 plan needs rethinking.

> ⚠️ **Known risk, partly de-risked.** whisper.cpp release binaries come from
> GitHub, which this network cannot reach. Checked against the npm mirror, these
> packages exist and are installable:
>
> | package | version | note |
> |---|---|---|
> | `smart-whisper` | 0.8.1 | whisper.cpp Node binding, "auto model offloading" |
> | `nodejs-whisper` | 0.3.1 | whisper.cpp bindings, CPU-oriented |
> | `whisper-node` | 1.1.1 | whisper.cpp bindings, CPU-oriented |
> | `node-whisper` | 2026.3.3 | async binding |
>
> None of them promises the **Vulkan** backend, and some fetch sources/binaries
> from GitHub during install. So the realistic outcomes are:
>
> 1. **Vulkan via whisper.cpp** — the design-doc target, needs a binary or a
>    source build (CMake + compiler + Vulkan SDK).
> 2. **CPU-only whisper.cpp** via one of the bindings above. Slower, but M1 is
>    not blocked: ASR is a one-off cost, and `large-v3-turbo-q8_0` on CPU is
>    minutes for a 45-minute file, not hours.
> 3. **No ASR at all** — the app already works from sidecar subtitles. Not a
>    disaster, just less automatic.
>
> Decide between 1 and 2 **before** writing `segment.ts`, because the choice
> determines whether we get word-level timestamps from `-dtw` or have to derive
> them ourselves.

Then:

1. `tools/whisper-cli.exe` + `large-v3-turbo-q8_0` + Silero VAD weights staged by
   `scripts/install-tools.mjs`
2. `lib/lesson/segment.ts` — the sentence re-splitter. **The single most
   important function in the project** (design doc §4.4). Pure function, fixture
   tests, most of the engineering effort belongs here.
3. Embedded-subtitle extraction via ffmpeg (cheap, and it can skip ASR entirely)
4. `node:child_process` job runner + `GET /api/transcribe/:jobId` SSE progress,
   staged `probing → extracting → vad → asr → segmenting → aligning → done`
5. Wire the UI to it, with a visible job progress strip

## 10. Verification log

What has actually been run, rather than assumed:

- `npm run typecheck` — clean
- `npm run ingest -- "<fixture>.mp4"` — 20 lines from `sidecar-vtt`, ffprobe
  reported `01:43 · audio yes`, lesson `6214067d2d98`
- re-running the same import — correctly reported `already imported`, no
  duplicate row
- `npm run ingest -- --list` — shows the library with duration, size, line count and path
- `GET /api/media/<id>` with `Range: bytes=0-1023` → `206`,
  `content-range: bytes 0-1023/3425891`
- with `Range: bytes=3400000-` → `206`, length `25891` (correct open-ended range)
- with `Range: bytes=-2048` → `206`, `content-range: bytes 3423843-3425890/3425891`
- with `Range: bytes=99999999999-` → `416` + `content-range: bytes */3425891`
- `HEAD /api/media/<id>` → `200` with `accept-ranges: bytes` and `content-length`
- `GET /watch/<id>` → `200`, 33 KB of HTML containing all 20 cue texts, the media
  URL and the practice controls

Shapes of the numbers that matter: fixture line 1 is `1200 → 6089` ms, which is
exactly `LEAD_IN (1200)` + the WAV's measured 4889 ms. The subtitle and the audio
are generated from the same arithmetic, so any drift seen later is the player's.

- `npm test` — **59 tests, 3 files, all passing**
  - `lib/server/range.test.ts` (13) — including the four ranges actually fired at
    the server above, plus the malformed/inverted/empty-file cases
  - `lib/lesson/vtt.test.ts` (28) — BOM + CRLF, `NOTE`/`STYLE` blocks, cue ids,
    inline tags, entities, cue settings, unparsable timestamps, zero-length cues,
    overlap trimming, and `cues → VTT → cues` / `cues → SRT → cues` round trips
  - `lib/sync/findActiveCue.test.ts` (18) — the highlight and prev/next line
    lookups, including the end-is-exclusive boundary and the 400ms restart rule
- Browser check via headless Chrome against the live dev server: `/watch/<id>`
  renders the full left/right split, all 20 transcript lines with timestamps
  `00:01 → 01:36`, and every practice/transport control, with no console errors.

## 11. Testing

`vitest` was already wired up (`npm test`) but there were **no test files**, so
the script exited 1 — that is now fixed. The rule for what gets a test: any
module that is a pure function of its arguments and encodes a decision that is
expensive to debug through the UI. That is `range.ts`, `vtt.ts` and
`findActiveCue.ts`; all three are covered above.

Two things this suite already paid for:

- `findPreviousCueIndex` returned `0` for an empty transcript while
  `findNextCueIndex` returned `-1`. Unreachable today (its only caller checks
  `list.length === 0` first), but it is the wrong default — the two are now
  consistent, so callers can uniformly test `< 0`.
- `parseSubtitleText` returns `{ cues, report }`, not `{ cues, format }`. Written
  down here because the first version of the round-trip test got it wrong.

`vitest.config.ts` mirrors the `@/*` path alias from `tsconfig.json`. Vitest does
not read tsconfig paths, so without it any test importing `lib/sync` or
`lib/server` fails to resolve.

Not yet under test — these need a real process or a real browser:
`ingestFile()` end to end (covered manually via the CLI instead),
`probe.ts` (needs the ffprobe binary), and everything under `hooks/`
and `components/`.
