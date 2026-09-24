# PROGRESS

Status log for the English Listening project. Read this first — it is written so
that a fresh session with no context can pick the work up.

Last updated: 2026-09-24 (M0 complete; **light study theme** + the fixture's test
pattern replaced by the audio's own waveform — §14; M1 not started)

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
npm run fixture -- --sentences 8          # a short fixture, for quick checks
npm run fixture -- --voice en-GB-RyanNeural
npm run fixture -- --list-voices          # what voices the TTS backend offers
npm run fixture -- --tts espeak           # regenerate the audio with no network
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
| Native OS file dialog ("Browse…") | works — **was silently broken until 2026-09-24**, see §12 |
| ffprobe metadata probe | works (reads `tools/ffprobe.exe`) |
| Sidecar `.vtt` / `.srt` discovery + parsing | works |
| Content fingerprint, re-import dedupe, re-point on move/rename | works |
| library list / remove (never touches the source file) | works |
| `GET /api/media/<id>` byte-range streaming | verified: 200 / 206 / 416 all correct |
| Player: play, pause, ±5s, prev/next line, scrub, rate, volume, fullscreen | implemented |
| Transcript: click to seek, sync highlight, auto-scroll + scroll lock | implemented, **needs a human eye** — see §7 |
| Repeat line / repeat ×N / pause after line | implemented |
| Progress memory (resume where you left off) | implemented |
| Light "study" theme, semantic colour tokens | implemented 2026-09-24 — see §14 |
| Audio-only lessons get a designed face instead of a blank box | implemented 2026-09-24 — see §14 |
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
| Test material = an open movie (Sintel / Tears of Steel) | Synthesised fixture: **Microsoft Edge read-aloud neural speech** + a generated "ruled paper & waveform" picture, with eSpeak NG as the offline fallback | `download.blender.org` is behind a Cloudflare challenge. The synthetic fixture is also a *stronger* test — see `testmedia/README.md` and §12.4. The picture replaced `testsrc` on 2026-09-24 (§14), because a test pattern reads as "no signal". |
| `lesson.json` field `video.duration` (seconds) | `video.durationMs` | Consistency: the whole codebase speaks milliseconds (invariant #5). |

## 7. Not yet verified — do this next

1. ~~**The native file dialog** (`POST /api/ingest/pick`).~~ **Fixed 2026-09-24.**
   It had never worked at all; see §12.2 for what was wrong. A human has since
   opened it and picked a file successfully.
2. ~~**Player feel, by a human.**~~ **Passed 2026-09-24** on the three things that
   were testable: highlight tracking, scrub feel, and the scroll-lock / "Back to
   current line" behaviour. What has *not* passed is the second half of M0's
   acceptance criterion — *"listen for 20 minutes without wanting to stop"* —
   because the fixture was formant-synthesised speech (§12.4). The fixture has
   now been re-voiced. **This is the one open item, and it needs a human ear.**
3. **Loop behaviour under a real hand.** "Repeat line" at 0.7x on the shortest
   line — line 12, `That changed everything, honestly.` at 2.1s. Confirm it does
   not stutter or double-trigger. Was deferred pending the re-voiced fixture, so
   it is still unverified.
4. **Replacing a file in place is not detected.** A lesson records the size and
   digest it was imported with, but nothing compares them against the file when
   the lesson is opened. If that file is overwritten with different content at
   the same path, `/api/media/<id>` streams the new bytes against the old
   transcript — silently wrong, the same family as §12.1 and §12.2. Regenerating
   the fixture reproduces it. Cheap fix: on load, compare
   `fs.statSync(video.path).size` (or recompute the digest) against `video.size`
   and surface it the way `missingSince` already is. **Not done** — it is new
   behaviour, not part of the fixture change.

## 8. Environment notes for this machine

These cost real time to discover. Do not rediscover them.

- **The shell has a near-empty PATH.** `ls`, `head`, `tr`, `seq`, `sed` are
  frequently *not* available, and `dirname` never is. Prefer the Read/Write/Glob/
  Grep tools, or drive everything through Node with an absolute path:
  `D:\MyConfiguration\TCLXUSER\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`
- **npm is proxied** to `http://nexus.17usoft.com/repository/npm-all/`. The
  public registry is reachable too.
- **The PowerShell tool blocks `Add-Type` and COM instantiation, and never
  returns stdout.** That rules out `System.Speech` TTS and `SAPI.SpVoice` from
  the agent, and makes PowerShell useless for reading anything back (writing to
  a file and then reading *that* does work — that is how this was established).
  For the record, `Microsoft Zira Desktop - English (US)` **is** installed as a
  SAPI5 voice, and the OneCore set contains only `zh-CN` voices. So Windows TTS
  was a dead end here regardless. See §12.4 for what replaced it.
- **Bash refuses to spawn `powershell.exe`**, by policy ("bypasses PowerShell
  security checks"). Do not route around this — the app itself is allowed to
  spawn it, and that is the only sanctioned path.
- **Outbound network from the agent sandbox is filtered**, and requests are
  routed through an egress proxy exported as `HTTP(S)_PROXY=127.0.0.1:61322`.
  Against some hosts that proxy **resets the TLS handshake**, so any library
  that honours the env vars (axios, most HTTP clients) fails where a plain
  `https.get`, or a WebSocket, succeeds. `speech.platform.bing.com` is exactly
  this case, which is why `msedge-tts`'s `getVoices()` needed `--no-proxy`.
  Reachability as measured on 2026-09-24:
  - **reachable** — `nexus.17usoft.com` (npm mirror), `registry.npmjs.org`,
    `cdn.jsdelivr.net` (including `/gh/<owner>/<repo>@<ref>/<path>`),
    `codeload.github.com`, `objects.githubusercontent.com`,
    `storage.googleapis.com`, `tatoeba.org`, `hf-mirror.com`, `modelscope.cn`,
    `ghfast.top`, `ghproxy.net`
  - **not reachable** — `github.com`, `raw.githubusercontent.com`,
    `api.github.com` (403), `huggingface.co`, `translate.google.com`,
    `upload.wikimedia.org`, `archive.org`, `download.blender.org`
  - Reachability is **not** stable run to run: a first probe of
    `speech.platform.bing.com` failed with `ECONNRESET` and a retry a minute
    later answered `200` three times in a row. Retry before concluding.
- **No system ffmpeg.** `npm run tools:install` vendors it into `tools/`. Note
  that build is old enough to lack `apad=pad_dur`; use plain `apad` plus `-t`.
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

> ⚠️ **Partly de-risked on 2026-09-24.** The assumption that "GitHub is
> unreachable" was too coarse — it is true of `github.com` and
> `raw.githubusercontent.com` and false of several other ways in. Measured (see
> §8 for the method):
>
> | What M1 needs | Route | Status |
> |---|---|---|
> | whisper.cpp **source** | `codeload.github.com/…/zip/refs/heads/master` | ✅ `200`, 200 KB zip |
> | whisper.cpp single files | `cdn.jsdelivr.net/gh/ggerganov/whisper.cpp@<ref>/<path>` | ✅ `200` |
> | whisper.cpp **release binaries** | `github.com` → `objects.githubusercontent.com` | ❌ `github.com` times out, so the signed asset URL cannot be obtained directly |
> | GitHub proxy services | `ghfast.top`, `ghproxy.net` | ✅ `301` — reachable; follow the redirect and see whether a prebuilt Vulkan binary comes through |
> | **ggml model weights** | `hf-mirror.com/ggerganov/whisper.cpp/resolve/main/…` | ✅ `307` on a repo path — follow the redirect |
> | the same weights from `huggingface.co` | ❌ times out |
> | npm bindings | `nexus.17usoft.com` | ✅ installable — `smart-whisper` 0.8.1, `nodejs-whisper` 0.3.1, `whisper-node` 1.1.1, `node-whisper` 2026.3.3 |
>
> So the realistic paths, in order of preference:
>
> 1. **Prebuilt binary through a GitHub proxy.** Cheapest if the proxy serves
>    release assets. Check whether a Vulkan build is among them — upstream
>    publishes CPU builds; the Vulkan one may have to be built.
> 2. **Build from source** via `codeload` (CMake + a compiler; Vulkan needs the
>    Vulkan SDK). Reliable, but a real afternoon, and the Vulkan SDK download is
>    its own reachability question.
> 3. **An npm binding, CPU-only.** None promises the Vulkan backend, and some
>    fetch from GitHub during install — so read the install script before
>    committing. Slow, but M1 is not blocked: ASR is a one-off cost, and
>    `large-v3-turbo-q8_0` on CPU is minutes for a 45-minute file.
> 4. **No ASR at all** — the app already works from sidecar subtitles. Not a
>    disaster, just less automatic.
>
> Decide **before** writing `segment.ts`, because the choice determines whether
> word-level timestamps come from `-dtw` or have to be derived here.
>
> **Useful side effect of §12.4:** the `edge` TTS backend now produces a real
> **word-boundary timeline** for synthesised speech, with 40–60 ms accuracy
> against measured speech onsets. That is exactly the shape `segment.ts` will
> have to consume, so the fixture can exercise the aligner *before* any ASR
> exists — and it gives a ground-truth timeline to check an ASR against later.

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

Shapes of the numbers that matter: on the original eSpeak fixture, line 1 was
`1200 → 6089` ms — that is `LEAD_IN (1200)` plus the WAV's measured 4889 ms, the
subtitle and the audio produced from the same arithmetic. The concept survived
the re-voicing in §12.4; what changed is that the times now come from the speech
engine's **own word boundaries** rather than being computed at all.

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
- `next build` — clean, **no warnings**. All 8 routes emit as expected (`/` and
  the API routes dynamic, `/_not-found` static). `findProjectRoot()` walks up
  from `cwd` looking for `package.json`, and Turbopack's tracer flagged that as
  "traces the whole project"; it now carries a `turbopackIgnore` comment. The
  access is dynamic by design (the CLI can start from any subdirectory) and this
  app is never deployed as a bundle, so the warning was noise — and noise that
  would have hidden the next real warning.
- `NETSTAT -ano` on the running server: `TCP 127.0.0.1:4317 LISTENING` — invariant
  #7 confirmed on the wire, not just in the source.
- `POST /api/ingest/pick`, before the fix → `200 {path:null,cancelled:true}` in
  **0.8s** (a working dialog cannot answer that fast; this is the measurement that
  proved the dialog never opened).
- the same call after the fix → **still pending at 14s**, i.e. blocked on a real
  dialog. Also caught an intermediate attempt that exited cleanly in 5.5s with no
  dialog (minimised owner form — see §12.2).
- `next build` after the 2026-09-24 fixes — clean, no warnings.

Fixture re-voicing, 2026-09-24 (§12.4):

- `node scripts/make-fixture.mjs --sentences 4 --name _smoke` — the strict
  word-to-sentence mapper passed on the first run, no adjustment needed.
- ffprobe on the smoke output — `h264` + `aac`, 451 video frames, 18.04s. Video
  and audio lengths agree.
- **Independent check that the cue times are real speech onsets**, not estimates:
  `ffmpeg -af silencedetect=noise=-35dB:d=0.20` on the smoke output, compared
  against the generated `.vtt`:

  | cue start (from the engine) | measured speech onset | delta |
  |---|---|---|
  | 0.700 | 0.749 | +49 ms |
  | 4.763 | 4.808 | +45 ms |
  | 8.113 | 8.158 | +45 ms |
  | 12.600 | 12.656 | +56 ms |

  All four within 45–56 ms and all in the same direction — the detector's
  threshold fires slightly after the true onset, which is what it should do. The
  two clocks are independent (one is the synthesiser's own timeline, the other is
  measured off the encoded AAC), so agreement here is real evidence.
- full regeneration — `36 lines, 401 spoken words, 123.7s total, 3.24 words/s`.
- `npm run ingest -- "testmedia/listening-fixture-01.mp4"` → `imported — lesson
  cdaff80b4a8d`, `36 lines from sidecar-vtt`, `02:04 · audio yes`.
- `GET /watch/cdaff80b4a8d` → `200`, 44 KB, **36 distinct cue timestamps**
  (`00:00` … `02:00`) plus the playhead, new line-21 and line-36 texts present,
  media URL rewritten to the new id.
- `GET /api/media/cdaff80b4a8d` → `200`, 4 111 261 bytes (full file, no Range).
- the stale lesson from the previous fixture was removed through the app's own
  API: `DELETE /api/lessons/6214067d2d98` → `200`, and crucially
  `{"sourceFileDeleted": false, "sourcePathKept": "…\\listening-fixture-01.mp4"}`
  — invariant #6 holds on the wire, not just in the source.

Slow-playback grain, 2026-09-24 (§13):

- **A measurement was attempted and abandoned; recorded so it is not retried.**
  The idea was to score "segmented-ness" as envelope modulation energy in the
  20–150 Hz band of the 2–5 kHz band, on the fixture stretched with
  `atempo`/`asetrate` and in nine variants. It does not discriminate: clean
  unmodified 1.0x material scores **53.4%** and the most heavily stretched
  material scores **49.9%**, because male voicing puts the fundamental
  (~110 Hz) squarely inside the measurement band, so the metric is reading
  voicing rather than seams. An earlier, cruder version of the same idea looked
  more promising (peaks at 84/112 Hz appearing only on stretched material) but
  that was the same F0 confusion. **There is no evidence here, and none of it
  is used in §13.**
- `ffmpeg -filters` on the vendored build → `atempo` present, **`rubberband`
  absent**. That is the constraint behind the options table in §13.
- What §13 actually rests on is the Chromium implementation itself (file and
  constants quoted there), which is stronger evidence than anything measurable
  from outside the media stack.

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

## 12. 2026-09-24 — first human pass over the player

The user listened to the fixture for the first time. Highlight tracking, "Back to
current line" and scroll lock all passed. Two real bugs surfaced, plus one
latent one. All three were things the automated checks could not have caught,
which is the point of §7.

### 12.1 Dragging the progress bar did nothing (fixed)

`onTrackPointerMove` called `paint(timeMs)` and **never touched
`currentTime`** — it repainted the bar without seeking. `onTrackPointerDown`
did seek, so a *click* on the bar worked and a *drag* silently sprang back to
wherever the video still was. The user's words: "拖了他还是会在原来的位置继续放".

Fix: one `commitSeek(timeMs)` used by the click path, the drag path and the ±5s
buttons. Drag seeks are coalesced to at most one per animation frame (a
pointermove fires far faster than the decoder can settle a seek, and flooding
`currentTime` makes scrubbing stutter rather than improve), and the exact release
position is flushed on pointerup.

**Invariant worth keeping:** every path that moves the playhead goes through
`commitSeek`. There is exactly one place that writes `video.currentTime`.

### 12.2 The Browse button had never once opened a dialog (fixed)

`POST /api/ingest/pick` returned `{path: null, cancelled: true}` in 0.8s and the
UI ignored `cancelled` entirely — hence "点了之后没什么反应". Three separate
defects stacked up:

1. **The script died on an invalid property.** It set `$dialog.TopMost = $true`,
   but `TopMost` is a `Form` member; `OpenFileDialog` has no such property.
   With `$ErrorActionPreference = 'Stop'` the script aborted on that line, so
   `ShowDialog()` was never reached. It failed 100% of the time, from the first
   commit onwards.
2. **A failure was reported as a cancellation.** The route discarded the exit
   code and stderr, so "the dialog threw" and "the user pressed Cancel" produced
   an identical response, and the UI only reacted to `path` or `error` — so the
   most common outcome was total silence. The route now returns 500 with the
   actual stderr text when the dialog could not be shown, and the UI shows a
   neutral note when the dialog genuinely closed empty.
3. **Diagnostics came back as mojibake.** Windows PowerShell writes to a
   redirected stream in the OEM codepage, so the error text arrived as
   `�ڴ˶������Ҳ������`. The script now sets
   `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` first.

A fourth attempt is worth recording because it *looked* right: replacing the
invalid property with an invisible **minimised owner form**
(`ShowDialog($owner)`) made the script exit cleanly in 5.5s with no dialog.
Windows refuses to display a modal dialog owned by a minimised window. Calling
`ShowDialog()` with no owner at all is what works — the process has no
foreground window of its own, so Windows grants the dialog the foreground.

**How this was verified without a human:** a working dialog *blocks*. The buggy
version answered in 0.8s; the fix answers never (still waiting after 14s). That
timing difference is the test, and it needs no one at the keyboard.

**Lesson:** for a "nothing happened" report, check the silent branches first.
Both bugs here were code paths that returned successfully while doing nothing.

### 12.3 Seeking to 0 reported a stale position (fixed)

`requestSync()` in `hooks/usePlaybackClock.ts` read
`videoRef.current?.currentTime ? ... : timeMsRef.current`. Since `0` is falsy, a
seek to the very beginning reported the previous position instead of zero. Now
tests the element, not the number.

### 12.4 Fixture audio was unusable for judging feel (fixed)

Reported as: the speech sounds "不太连贯 / 人的声音怪怪的" even at 1x, and the loop
test was impossible to judge because of it.

That diagnosis was correct and expected. The fixture used **eSpeak NG**, a
formant synthesiser: it is excellent at crisp word boundaries, which is why it
made timing bugs easy to hear, and it does not sound like a person. It was
therefore fine for verifying sync and useless for the thing M0 actually asks —
*"listen for 20 minutes without wanting to stop"*. A second, smaller cause was
the fixture design itself: each sentence was rendered separately and glued
together with a fixed 700 ms gap, so the prosody restarted on every line.

**Dead ends, recorded so they are not re-explored:**

| Idea | Why it failed |
|---|---|
| Windows SAPI (`System.Speech` + `Microsoft Zira Desktop - English (US)`, which *is* installed) | the PowerShell tool blocks `Add-Type` |
| `SAPI.SpVoice` over COM | the PowerShell tool blocks COM instantiation |
| WinRT `Windows.Media.SpeechSynthesis` (no `Add-Type` needed) | reaches only the **OneCore** voice set, which on this machine has `zh-CN` only — no English |
| spawning `powershell.exe` from Node | Bash refuses it by policy, correctly; and the PowerShell tool never returns stdout anyway |
| Edge neural voices, first attempt | the sandbox's egress proxy (`HTTP(S)_PROXY`) reset the TLS handshake — see §8 |

**What was built.** `scripts/make-fixture.mjs` now has two backends. The default
is `edge`: Microsoft Edge's read-aloud **neural** voices, reached through
`msedge-tts`. The offline fallback stays `espeak`.

The important change is not the voice, it is the timing architecture:

- The whole passage is synthesised in **one request**, so the prosody flows the
  way speech actually flows — no stitching, no artificial gaps.
- Word boundaries are switched on, so the engine returns the exact **onset and
  duration of every spoken word** (100-nanosecond ticks).
- The subtitle is produced by grouping those words back into the sentences they
  came from, with a **strict** matcher: any sentence whose spoken words do not
  match one-for-one is a hard error naming the mismatching word, not a warning.
  A number or a contraction expanding would otherwise shift a line silently.
- Cue times are therefore **measured from the audio**, not computed. The
  `lead-in` is added afterwards, so line 1 starts at `00:00:00.700` = the
  engine's first spoken onset (~100 ms) + a 600 ms lead-in.
- Each cue ends where the next begins. Otherwise the 100–400 ms pauses between
  sentences briefly highlight nothing, which reads as a glitch rather than as a
  pause — and for a listening drill the trailing pause is part of the line.

**New fixture:** 36 sentences, 401 words, 2:03, 3.24 words/s, voice
`en-US-AndrewNeural`. Still `testsrc` video with 1-second keyframes.

**Deployment note.** `msedge-tts` is a **dev dependency only**, and it is a
reverse-engineered client for an unofficial endpoint. That is fine for
generating a local fixture and would not be fine for anything shipped. Nothing
at runtime touches it: the `.mp4` and `.vtt` it produces are ordinary local
files, so the app runs with the network off.

**Unplanned bonus for M1:** a word-boundary timeline is exactly what
`lib/lesson/segment.ts` will have to consume. The fixture can now exercise the
aligner, and act as ground truth to measure an ASR against, *before* any ASR
exists. Noted in §9.

## 13. Slowed playback sounds "segmented" — diagnosed, not a bug

Reported 2026-09-24, after the re-voicing: *"音频放慢之后，会有断层感…就是感觉会有一节一节的"*
— explicitly **not** a pitch shift, barely there at 0.7x, and worse the slower
you go.

**It is Chromium's time-stretcher, not this app.** Nothing in the request path
is involved: `preservesPitch` is set to `true` in `ControlBar`, `playbackRate` is
written exactly once per rate change (not per frame), and `usePlaybackClock`
never seeks on its own during ordinary playback. There is nothing left for us to
fix at the call site.

### 13.1 Where it comes from

`media/filters/audio_renderer_algorithm.cc` in Chromium. The relevant facts,
read from the source rather than inferred:

- `FillBufferMode { kPassthrough, kResampler, kWSOLA }`.
- `ChooseBufferMode()` picks: `kResampler` if `preserves_pitch_` is false, then
  `kPassthrough` when the rate is ~1.0, and **`kWSOLA` for everything else**.
- The stretch is a 20 ms overlap-add window (`kOlaWindowSize = 20ms`) advanced by
  a hop of half that, with a ±15 ms search (`kWsolaSearchInterval = 30ms`) for
  the block that best continues the waveform.
- The older header comment is unusually frank — the rate limits come with
  *"Audio outside of these ranges are muted"* and then this line, about the
  limits themselves: **"Audio at these speeds would sound better under a
  frequency domain algorithm."**
- Chromium commit `ab98b39` (2019, "Use resampler for playback speeds close to
  1.0") describes the same artifacts in its own words — *"warbling or transient
  stuttering"* — and switches to plain resampling for rates within 5–6% of 1.0,
  on the reasoning that inside that window the WSOLA artifacts are worse than a
  one-semitone pitch shift, and outside it the reverse.
- MDN, for the generic picture: browsers mute audio outside about 0.5x–4x.
  Our slowest offered rate is 0.6x, so we sit just above that floor — deep in
  WSOLA territory, which is exactly where the grain lives.

### 13.2 Why it sounds like discrete chunks

WSOLA stretches by *re-inserting* 20 ms blocks. For each one it hunts ±15 ms for
the block that best continues the waveform. Speech is close to periodic, so when
the matcher lands on something that is a whole number of pitch periods away the
seam is invisible. When it does not, summing the two windows partially cancels
and leaves a short broadband dip — a notch the width of one window, once per
iteration. You do not hear a smear, you hear *events*. That is the "一节一节的".

The rate dependence follows directly: at 0.7x roughly 43% of the output is
inserted material, at 0.6x about 67%, and the number of seams per second rises
with it. The user's account — ignorable at 0.7x, worse lower down — is the
predicted shape, and it matches where Chromium's own authors put the boundary.

### 13.3 Why the obvious alternative is worse for this app

`preservesPitch = false` switches Chromium to `kResampler`: completely smooth,
with no seams at all, but the speech drops in pitch and **its formants move with
it**, so vowels stop being the vowels. For a listening trainer that is the wrong
trade — grain is annoying, wrong vowels are misleading. Hence the current
setting is deliberate, and the honest conclusion is that **~0.7x is the floor**
of what this playback path can do well.

### 13.4 Options if better slow audio is ever wanted

| Option | Cost | Verdict |
|---|---|---|
| `atempo` used offline to pre-render a slowed copy | free | Same family — `atempo` is a time-domain overlap-add algorithm too, so expect the same class of artifact at render time instead of playback time. Also, the vendored ffmpeg has **no `rubberband` filter** (verified with `ffmpeg -filters`), which is the one that is a real phase vocoder. |
| an ffmpeg build with `librubberband` | medium | The right tool: formant-preserving phase vocoder. Needs a custom build. |
| a browser-side stretcher (`rubberband-wasm`, SoundTouch in an `AudioWorklet`) | large | Would genuinely fix it, but requires decoding the whole lesson into an `AudioBuffer` and driving playback from Web Audio: memory scales with lesson length (~1 GB for a 45-minute stereo lesson), and it **inverts invariant #4** — audio would become the master clock and the video would have to follow. A project, not a patch. |
| drop to `preservesPitch = false` below some rate | trivial | Rejected — §13.3. |

**Recommendation, unbuilt:** for the comprehension problem that slow playback is
trying to solve, repetition beats speed. `Repeat Line` / `×N` / `Pause after
line` already exist, so a "slow practice" preset of ~0.8x with 3 repeats gets
most of the benefit while staying in the region where WSOLA is clean. Offered,
not assumed.

### 13.5 Also considered and dropped

The fixture's source audio is a **48 kbps MP3** (`OUTPUT_FORMAT` in
`scripts/make-fixture.mjs`), and one might expect low-bitrate source material to
make a stretcher's alignment search less reliable, amplifying the grain.
Measuring that failed for the same reason as in §10, so it is unresolved and
**the fixture was deliberately not regenerated on a hunch** — it currently
sounds good at 1x and churning it would cost a re-listen for no demonstrated
gain. If it is ever regenerated for another reason, the enum also offers
`AUDIO_24KHZ_96KBITRATE_MONO_MP3` and `WEBM_24KHZ_16BIT_MONO_OPUS`.

## 14. Light study theme + the end of the test pattern — 2026-09-24

The user asked for a fresher, lighter look ("暗黑色有点压抑") and for the
fixture's test-pattern frame to be replaced. The theme work was scheduled for
M5 ("主题/字号") and pulled forward; M1 remains the next milestone.

### 14.1 The theme: role tokens, not a lightness ramp

The old palette was an `ink-100…ink-950` ramp. That silently encodes "dark
background": when the theme flips, `ink-100` means the opposite of its name and
every call site has to be re-judged by hand. The new tokens are named by ROLE —
`canvas / surface / sunken / raised`, `line / line-strong`,
`ink / ink-soft / ink-muted / ink-faint`, `accent / accent-strong /
accent-bright / accent-wash / accent-line` — so a theme change is a value
change, not a semantics change.

The migration was mechanical and audited: 25 distinct tokens, 116 replacements
across 9 files, with a leftover check that fails loudly on any unmapped token
(it passed; the only hits left were in prose). What the script could NOT do was
the judgement calls, and those are where the real work was:

- **Accent polarity inverts.** On dark, the *lighter* accent is the readable
  one for text; on light it is the darker. `text-accent-400` became
  `text-accent-strong`, `bg-accent-600` became `bg-accent-strong`, and so on.
- **The active line is a teal wash, not a grey step.** On a light theme a grey
  highlight does not read as "this is the line you are hearing". It is also
  deliberately a *different* tint from hover, so the two can never be confused.
- **Hover must darken, not lighten.** The old dark-theme hovers mapped onto
  values that were lighter than their base — invisible on white. Two controls
  also collapsed into no-op hovers (`hover:border` equalling the base border);
  both fixed, and the Remove button now hints red, which it should have done
  from the start.
- **Amber/red status text went from light-on-dark tints to AA-contrast darks**
  (`text-amber-300` → `text-amber-800`, `text-red-300` → `text-red-700`).
- **Text contrast was checked at the sizes actually used.** Most of this UI is
  11–12px, below the "large text" exemption, so 4.5:1 is the bar. That is why
  `--color-ink-muted` is `#557068` and not the prettier `#66817a`.

Fullscreen inverts the *tokens* rather than the components: a `:fullscreen`
block re-scopes the same variable names to dark values, so the player shell
goes dark with zero per-component `fullscreen:` classes, while the practice bar
and transcript (outside the fullscreen element) stay light. Tailwind has no
built-in `fullscreen:` variant; `@custom-variant` covers the few structural
cases (drop the stage padding and the video's rounded corners).

**Deliberately not built: a theme toggle.** It is now cheap (the tokens exist),
but the user asked for light, and M5 owns "主题/字号" properly. Note that the
dark values from the old theme are recoverable from git history if a toggle is
ever wanted.

### 14.2 The picture: ruled paper and the audio's own waveform

The fixture's video was `testsrc` — a colour-bar test pattern with a burnt-in
frame counter. In a player that reads as "no signal", which is what the user
complained about ("无信号花屏图案").

The new picture: a mint "ruled paper" background generated per pixel by the
fixture script (dependency-free PNG writer, ~2.7 MB of RGB, deflate-compressed),
with the **actual audio** drawn over it as a scrolling waveform via
`showwaves` at 60% alpha in the app's accent colour, plus a small caption
naming the fixture and the voice.

Why this and not something prettier: the waveform is *true*. It is generated
from the same audio track the file contains, in the same filter graph, via
`asplit` — so the picture and the sound cannot disagree. A flat line means
silence, a burst means a word, and a seek that "missed" is visible. That is
more useful to a listening trainer than a decorative gradient, and unlike a
fake level meter it cannot lie.

Implementation notes worth keeping:

- `showwaves` in this 2018 ffmpeg build **does emit alpha** (verified by
  decoding a frame to raw RGBA and reading the corners: `[0,0,0,0]`), so it
  composites onto a light background with a plain `overlay`. No `blend` math.
- The audio chain is `adelay → apad → asplit`, one branch feeding the file's
  audio track, the other feeding the waveform — so the wave includes the
  lead-in and tail padding, and stays in sync with the subtitle timeline.
- The caption is drawn **inside** the `-filter_complex` graph. ffmpeg refuses
  `-vf` on a stream that a complex filtergraph already feeds.
- Two bugs caught by looking at a frame rather than trusting the exit code: the
  background's soft glow *added* to channels already near 255, and `Buffer`
  assignment wrapped them mod 256, painting a magenta ring; and the Edge
  backend's scratch dir was briefly shadowed by a same-named variable, which
  would have leaked a temp dir on every run.

### 14.3 Also new: audio-only lessons get a face

`VideoPane` now tracks a `phase` (`loading / picture / audio`) and shows a
designed panel for audio-only files — which the import panel has always
accepted (mp3 / m4a / wav) and which previously rendered as a blank black
rectangle. The decision comes from `videoWidth === 0` on the element itself,
not from ffprobe, so it is correct even for lessons imported before this
existed, with no re-import.

The panel's glyph **breathes, it does not meter**. A moving level meter that
did not follow the audio would be a lie; reading real levels would mean an
`AnalyserNode` and a render loop on a panel whose only job is to fill an empty
rectangle. The distinction is written into the CSS next to the keyframes.

### 14.4 Verification

- `tsc --noEmit` clean; **59/59 tests pass**; `next build` clean, no warnings,
  8 routes.
- Headless Chrome against the live dev server: the watch page renders the light
  theme end to end — white panels, mint stage, teal active-line wash, visible
  seek thumb — and the new lesson (`c5a557c6fa29`, 36 lines) served with the
  new picture.
- Frames extracted from the encoded mp4 and *looked at*: ruled paper, caption,
  and a real speech envelope (syllable bursts, flat during silence). The first
  prototype's magenta ring was caught this way; the fixed version was re-checked
  the same way.
- Old lesson removed through the app's API before re-import:
  `DELETE /api/lessons/cdaff80b4a8d` → `200`,
  `{"sourceFileDeleted": false, "sourcePathKept": "…listening-fixture-01.mp4"}`
  — invariant #6 holds on the wire again.
- Full regeneration: `36 lines, 401 spoken words, 123.7s, 3.24 words/s`,
  imported as `c5a557c6fa29`, `36 lines from sidecar-vtt`.
- **Not verified by automation:** the browser daemon under test kept resetting
  its tab to `about:blank` mid-session, so a screenshot of the wave *mid-
  playback* was not captured. The mp4's own frames were verified with ffmpeg,
  and the in-app frame at t=0 was captured — the wave's motion is inherent to
  the file, not to the player. Worth one human glance.

### 14.5 Still open

- §7 item 4 (in-place file replacement is not detected) is now *likely to bite*,
  because regenerating the fixture is a normal operation and every regeneration
  orphans the old library entry. Recommended before M1: on lesson load, compare
  the recorded `sizeBytes` against the file and surface a mismatch the way
  `missingSince` is surfaced.
- M1 Step 0 (whisper.cpp gate) is untouched. §9's route table stands.
