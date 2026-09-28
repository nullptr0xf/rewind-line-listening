# PROGRESS

Status log for the English Listening project. Read this first — it is written so
that a fresh session with no context can pick the work up.

Last updated: 2026-09-24 (M0 complete; light study theme + waveform fixture — §14;
M1 complete except embedded-subtitle extraction, which was **dropped on purpose**
at the user's request — the transcription pipeline now runs end to end from
`ffmpeg` through `whisper-cli` to `lesson.json`, with live progress in the UI and
a CLI — §15, §16)

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
npm run tools:install    # stages ffmpeg + ffprobe, whisper.cpp, a ggml model and Silero VAD into ./tools
npm run fixture          # generates testmedia/listening-fixture-01.{mp4,vtt}
npm run dev              # http://127.0.0.1:4317
```

Other commands:

```bash
npm run ingest -- "<path to a video>"     # import from the command line
npm run ingest -- --list                  # show the library
npm run ingest -- "<folder>"              # list candidates; imports nothing until --all / --only 1,3
npm run transcribe -- --list              # what still needs a transcript
npm run transcribe -- <lesson-id>         # transcribe it (ffmpeg -> whisper.cpp -> lesson.json)
npm run transcribe -- --all-missing       # every lesson that has no transcript
npm run fixture -- --sentences 8          # a short fixture, for quick checks
npm run fixture -- --voice en-GB-RyanNeural
npm run fixture -- --list-voices          # what voices the TTS backend offers
npm run fixture -- --tts espeak           # regenerate the audio with no network
npm test                                  # 157 unit tests over the pure modules
npm run verify:step                       # do ←/→ really walk the transcript one line at a time?
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
| `segment.ts` — the sentence re-splitter (doc §4.4) | implemented 2026-09-24 — see §15.4 |
| whisper.cpp JSON reader + token→word assembly | implemented 2026-09-24 — see §15.4 |
| `npm run bench:asr` — ASR/segmentation acceptance harness | implemented 2026-09-24 — see §15.4 |
| `npm run inspect:timeline` — explains *why* timings are off | implemented 2026-09-24 — see §15.10 |
| `npm run tools:install` stages whisper.cpp, a model, Silero VAD | implemented 2026-09-24 — see §15.7 |
| `--vad` timeline reconciliation (the speech-vs-audio split) | implemented 2026-09-24 — see §15.10 |
| `lib/server/asr.ts` — toolchain discovery + progress parsing | implemented 2026-09-24 — see §16.1 |
| `lib/server/transcribe.ts` — the `ffmpeg → whisper-cli → lesson.json` job runner | implemented 2026-09-24 — see §16.2 |
| Transcription API: start / list / SSE progress / cancel | implemented 2026-09-24 — see §16.4 |
| `npm run transcribe` — the same runner with no UI in the loop | implemented 2026-09-24 — see §16.3 |
| UI: a live progress strip, in the library and on the player | implemented 2026-09-24, **needs a human eye** — see §16.5 |
| `lib/server/download-tools.ts` — downloader discovery, proxy resolution, progress parsing | implemented 2026-09-28 — see §18.2 |
| `lib/server/download.ts` — the URL download job runner (download → ingest) | implemented 2026-09-28 — see §18.3 |
| Download API: start / list / SSE progress / cancel, plus dedupe by URL | implemented 2026-09-28 — see §18.4 |
| UI: a URL box that downloads and imports, on the library page | implemented 2026-09-28, **needs a human eye** — see §18.5 |
| `npm run fetch` — the same runner with no UI in the loop | implemented 2026-09-28 — see §18.6 |
| `npm run downloader:install` — stages youtube-dl into `tools/downloader` | implemented 2026-09-28 — see §18.6 |
| Unit tests over the pure modules | 219 passing — see §11 |

### Deliberately NOT implemented yet

- **Upload / drag-and-drop import.** The design doc lists it as entry point #2
  and explicitly as the fallback, because a browser cannot hand us a real
  filesystem path. Only entry #1 (path) and #3 (CLI) exist. Deferred.
- **Embedded subtitle extraction** from the container. **Not deferred — decided
  against**, 2026-09-24, at the user's request. Detected and reported, with the
  one-line `ffmpeg` command to export it, so the user is never stuck; but the
  container is never read. See §9 step 3 for the reasoning.
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
   it. `lib/server/asr.ts`, `ingest.ts`, `probe.ts`, `path.ts`, `repo.ts`,
   `db.ts`, `transcribe.ts` and `config.ts` are all pure Node.
3. **A client component must never import a *value* from `lib/server/**`.** The
   mirror image of #2, and it bit us once: importing `STAGE_LABELS` from
   `lib/server/transcribe.ts` into `TranscribePanel` dragged the whole server
   graph — `repo` → `db` → `better-sqlite3` → `fs` — into the browser bundle. The
   error ("Module not found: Can't resolve 'fs'") names a SQLite binding and
   points nowhere near the actual mistake. Type-only imports are fine (they are
   erased); shared *values* belong in `lib/lesson/**`, which is why the stage
   vocabulary lives in `lib/lesson/stages.ts`.
4. **Everything downstream of import works on an absolute path.** Nothing
   downstream knows what an "upload" is.
5. **`currentTime` never enters React state.** Per-frame consumers
   (`ControlBar`'s playhead) subscribe to the clock and write to the DOM.
   Only the active line index is state. See `hooks/usePlaybackClock.ts`.
6. **Time is integer milliseconds everywhere.** Seconds only exist at the UI
   and export boundary. See `lib/lesson/schema.ts`.
7. **Nothing ever deletes a user's file.** `removeLesson()` deletes our index
   row, `data/lessons/<id>/` and the derived transcription cache in
   `data/cache/<id>/`, and only deletes media it copied itself (`managed === 1`).
   The discard case does not exist in this codebase.
8. **A long job pushes full snapshots, not deltas.** Every transcription state
   change publishes the complete job, so a client that connects late or
   reconnects is immediately correct and no replay buffer is needed. See
   `lib/server/transcribe.ts`.
9. **The app only listens on `127.0.0.1`.** The ingest API can read any path the
   user can read, so exposing it to the LAN would be a file-disclosure hole.
10. **A URL download is not a second ingest path.** `lib/server/download.ts`
    downloads, then calls `ingestFile()` exactly like a local import — #1 still
    holds, and the downloader is only a way of *producing* the absolute path
    that #4 requires. This is also why the downloader is optional: everything
    downstream of `ingestFile()` works with no downloader present at all.
11. **Never use `spawnSync`.** Every child process in this codebase is spawned
    asynchronously. On this machine `spawnSync` fails with `EBUSY` in *all four*
    variants (measured 2026-09-28, §18.7) — including from a plain Node script
    with nothing else running — so a synchronous probe does not fail loudly, it
    returns an empty result that reads exactly like "not installed". This cost
    hours: the python-discovery and registry probes were silently answering
    "nothing here" while python sat on disk. See `lib/server/run-process.ts`.

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
5. **The URL box, by a human.** The API behind it is verified end to end
   (§18.9) and the panel server-renders, but nobody has yet typed a URL into the
   real page, watched the bar move, and clicked through to the player. The one
   thing that genuinely needs eyes: the reattach path — reload the page
   mid-download and the box should pick the job back up from `localStorage`
   rather than offering to start a second one. That is client-only and no HTTP
   test can see it.
6. **Only YouTube has been exercised as a source.** The downloader claims to
   handle ~1000 sites and the app does nothing YouTube-specific, but "the
   extractor set works" is an assumption, not a measurement. A Vimeo or
   SoundCloud URL is the cheap next check; a site whose subtitles are *not* in
   `en` is the other (the caption language is a config value that has never been
   changed from its default).

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

1. ~~whisper.cpp + a model + Silero VAD weights staged by
   `scripts/install-tools.mjs`~~ — **done**, see §15.7. The default model ended up
   being `base.en-q8_0` rather than `large-v3-turbo-q8_0`, for measured reasons
   (§15.10).
2. ~~`lib/lesson/segment.ts` — the sentence re-splitter. **The single most
   important function in the project** (design doc §4.4). Pure function, fixture
   tests, most of the engineering effort belongs here.~~ — **done**, see §15.4.
3. ~~Embedded-subtitle extraction via ffmpeg (cheap, and it can skip ASR
   entirely).~~ — **dropped on purpose, 2026-09-24, at the user's request.** The
   reasoning is worth keeping, because the doc's own justification made it look
   free. Two things outweighed it:
   - It only *sometimes* skips ASR. A file with no subtitle stream still needs
     the full pipeline, so it is a second transcript path to build, test and
     explain — not a replacement for the first one.
   - It is one command the user can type:
     `ffmpeg -i in.mkv -map 0:2 -c:s webvtt out.en.vtt`. Sidecar discovery
     already matches on basename, so the exported file is picked up on the next
     import with **no new code at all**.

   So the container stays unread. Instead `ingest.ts` prints that exact command
   (with the file's real stream index and a sensible output name) when it sees
   embedded subtitles, and calls out image-based codecs (PGS/VobSub) separately,
   because the command silently yields an empty file for those.
4. `node:child_process` job runner + SSE progress, staged
   `probing → extracting → transcribing → assembling → segmenting → writing → done`

   > Two deliberate departures from the doc's stage list
   > (`probing → extracting → vad → asr → segmenting → aligning → done`): `vad` is
   > not a stage because `--vad` is a flag on the `whisper-cli` call rather than a
   > pass over the audio, and `aligning` does not exist because `-dtw` produces
   > word timings *during* the ASR pass — there is no separate forced-alignment
   > step to wait for on this route.
5. Wire the UI to it, with a visible job progress strip

**Done in §16.** Steps 4 and 5 are implemented, plus a `npm run transcribe` CLI
that drives the same runner with no UI in the loop.

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
  - `lib/sync/findActiveCue.test.ts` (20) — the highlight and prev/next line
    lookups, including the end-is-exclusive boundary, the no-restart rule and
    prev/next symmetry (§17)
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
expensive to debug through the UI. That is `range.ts`, `vtt.ts`,
`findActiveCue.ts`, and — added in §15 — `segment.ts` and `whisper.ts`, plus
`lib/server/asr.ts` (toolchain resolution and the two progress parsers) and
`lib/server/transcribe.ts` (the job state machine, driven by injected fake steps
so the risky part is testable without spawning anything) in §16, and
`lib/server/download-tools.ts` (option construction, `--help`-verified flags,
progress parsing, and the proxy ladder with the health check injected — §18)
in §18. The count is **219 tests**.

The new download suite is the clearest case yet for *why* the injected-seam
pattern is worth the trouble. `resolveDownloadProxy` takes its `check` and
`registry` as parameters, so the tests exercise the full candidate ladder —
config → env → registry → common ports, rejection reasons and all — with **no
socket, no `reg.exe`, and no proxy running**, and they run in milliseconds
instead of waiting out real timeouts. The production path and the tested path
differ only in which function is passed in.

Some behaviours need more than a unit test, and get a named entry point instead
(`npm run bench:asr`, `npm run inspect:timeline`, `npm run verify:step` — §15.10,
§17). The test for choosing one over the other: does the bug depend on data the
unit test does not have? A **position-dependent** bug cannot be caught by three
synthetic cues; it needs real line lengths, which only the fixture provides.

The one caveat learned the hard way (§15.10): a green suite says the code does
what the *tests* were written to check, and the tests were written from the same
misunderstanding that produced the bug. All 107 passed while `--vad` was shifting
every cue by ~900 ms — because nothing in the suite contained a VAD timeline,
which was the entire defect. Numbers that came from *measuring reality*
(`npm run bench:asr`, `npm run inspect:timeline`) are what caught it.

`segment.ts` deserves the most tests of anything in the project, and for a
specific reason: its rules are *ordered* (rule 4 legitimately undoes rule 3 for a
sub-second clause), so the interactions are the hard part, not the individual
rules. The suite pins the interactions, not just the rules.

Three findings this suite paid for:

- `findPreviousCueIndex` returned `0` for an empty transcript while
  `findNextCueIndex` returned `-1`. Unreachable today (its only caller checks
  `list.length === 0` first), but it is the wrong default — the two are now
  consistent, so callers can uniformly test `< 0`.
- `parseSubtitleText` returns `{ cues, report }`, not `{ cues, format }`. Written
  down here because the first version of the round-trip test got it wrong.
- `classifyEnding` treated a trailing `"10."` as a numbered-list marker, so
  `"…the streets are after 10."` never ended a sentence. The unit test suite did
  not miss this — it **asserted the wrong behaviour**, which is worse. Only the
  end-to-end run against real whisper output (§15.6) exposed it. When a test and
  reality disagree, check which one you wrote from a measurement.

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

## 15. M1 Step 0: the whisper.cpp gate — 2026-09-24

Step 0 in the design doc was: *"get whisper.cpp running with the Vulkan backend
on this machine's Arc 140T and confirm it transcribes the fixture faster than
real time. If this fails, the whole M1 plan needs rethinking."*

**The gate passes.** But it passed on the route the doc treated as the fallback,
and measuring it turned up two things the doc gets wrong. Both numbers below are
measured on this machine, not quoted.

### 15.1 Measured: CPU-only is already far past the bar

The prebuilt `whisper-bin-x64.zip` (v1.7.6) is a **CPU build**. There is no
Vulkan binary in the upstream release, so "whisper.cpp + Vulkan" was never
actually obtained — and it turns out not to matter yet.

| Model | Backend | Fixture (123.7s) | Real-time multiple | WER |
|---|---|---|---|---|
| `base.en-q8_0` (78 MB) | CPU, 8–16 threads | **7.9 s** | **15.7×** | 1.00% |
| `large-v3-turbo-q8_0` (834 MB) | CPU, 8–16 threads | **58.0 s** | **2.13×** | 1.00% |

Against the doc's premise (§6: "CPU ≈ 0.3× real time"), that is roughly **50×
better than predicted**. Two reasons, both worth writing down:

1. The doc's 0.3× figure is for **full `large-v3`**, not `-turbo` and not `-q8_0`.
2. §6's Vulkan numbers came from a **Core Ultra 7 155H**, a different chip.

**And the turbo number settles the question.** Both models reach the same WER
(1.00%, 4 edits) on this fixture, so the 7× slower model buys nothing measurable
while costing 7× the time — and it is also *worse* on boundaries, for a reason
found later (§15.10). So the expensive detour (Vulkan SDK + CMake + a toolchain
whose own download is a reachability question — §9 route #2, "a real afternoon")
is **not required**: the CPU build clears the bar by more than an order of
magnitude, and the model that would have justified the GPU is not an upgrade.

Vulkan would still matter for a **much larger** model (`large-v3` non-turbo) on
longer files. That is a lever to keep in the drawer, not a prerequisite.

### 15.2 `offsets` are unusable — `t_dtw` is the real timeline

The single most useful finding. With `-ojf`, whisper.cpp gives every token an
`offsets.from/to` **and** a `t_dtw`. The obvious choice is wrong:

- Interior tokens routinely come back **degenerate** (`from === to`): 49 of 463.
- Worse, **each segment's `offsets.from` includes the leading silence** before
  its first word. Segment 0 reports `offsets.from = 0` while its first word
  actually starts at 780 ms — an **800 ms error on the first cue of every
  segment**, which is exactly the "时间戳漂移" risk in §17.
- `t_dtw` is a **global** frame counter (it does not restart per segment) in
  **10 ms units**: max `t_dtw` 12198 → 122.0 s against 123.7 s of audio.

> **Correction added in §15.10.** "Global" is true only when `--vad` is **off**.
> Under `--vad` the same counter runs on whisper's *speech-only* timeline, and the
> reader has to translate it. Read §15.10 before trusting any timing from a
> `--vad` run.

**And `t_dtw` marks each token's END, not its start.** Decided by running both
readings against the fixture's hand-verified VTT and scoring all 36 sentences:

| Reading | cue-start mean err | p90 | cue-end mean err | p90 |
|---|---|---|---|---|
| `t_dtw` = token start | 240 ms | 275 ms | 256 ms | 275 ms |
| **`t_dtw` = token end** | **175 ms** | **700 ms** | **178 ms** | **193 ms** |

The means are close, so the decision rests on the joins: at sentence boundaries
the "end" reading reproduces the VTT to **3 ms** (4760 vs 4763 ms) where the
"start" reading is consistently ~80 ms late. A token therefore spans
`[previous token's t_dtw, this token's t_dtw]`.

Two consequences that shaped the code:

- The pause between two words is carried by the **earlier** word's span. Without
  a cap, a trailing `.` swallows a three-second silence and the segmenter's gap
  rules never fire again — hence `maxWordMs` (600 ms) in `whisper.ts`.
- DTW has **no answer** for the very first token of the file, so it falls back to
  the first segment's `offsets.from`. That is the one place leading silence can
  still leak in; in the real pipeline VAD trims it first.

### 15.3 The doc's hallucination filter cannot be built as written

§4.4 lists `avg_logprob < -1.0`, `no_speech_prob > 0.6` and
`compression_ratio > 2.4` as filters. **whisper.cpp's JSON contains none of
them.** It emits only `timestamps` / `offsets` / `text` per segment, plus (with
`-ojf`) per-token `id`, `p` and `t_dtw`. Those three fields are Python-`whisper`
vocabulary, not this engine's.

What is actually available, in order of usefulness:

| Doc's field | Available? | Substitute |
|---|---|---|
| repeated-fragment / blacklist | — | unchanged, pure text |
| `avg_logprob` | no | mean of per-token `p` |
| `compression_ratio` | no | computable in Node via `zlib` |
| `no_speech_prob` | **no** | VAD (`--vad`) is the real answer; §4.3 already recommends it |

### 15.4 What was built

| File | What it is | Tests |
|---|---|---|
| `lib/lesson/segment.ts` | The sentence re-splitter, doc §4.4 rules 1–6 | 29 |
| `lib/lesson/whisper.ts` | whisper JSON reader + token→word assembly + timeline reconciliation | 19 |
| `scripts/install-tools.mjs` | now also stages whisper.cpp + a model + Silero VAD | — |
| `scripts/bench-asr.ts` | `npm run bench:asr` — M1's acceptance criterion, executable | — |
| `scripts/inspect-timeline.ts` | `npm run inspect:timeline` — *why* timings are off, not just how far | — |

`segment.ts` is deliberately a pure function of `CueWord[]`, so it does not care
which route produced the words. That is what let §9's "decide the route **before**
writing `segment.ts`" be satisfied without waiting: the schema already had the
right shape (`CueWord {w,s,e}`), and both a DTW timeline and a forced aligner
produce it.

Test count went **59 → 100 → 107**.

### 15.5 One documented deviation, and the fixture vindicated it

Rule 4 (fold anything under `minDur`/`minWords` into a neighbour) as written
glues `"Yes."` onto the end of the previous sentence. `keepShortSentences`
(default on) instead keeps a short chunk that actually terminated.

The end-to-end run justifies it: `"Small talk."` — a 1.06 s, two-word sentence
that is a real standalone utterance in the source text — survives as its own cue,
which is exactly what a repeat-listening trainer wants.

### 15.6 Three bugs found by running it, that unit tests did not find

Worth recording, because the pattern is the point: each was invisible to 100
green unit tests.

1. **The WER scorer was wrong.** It sliced the VTT block from index 1, keeping
   the timestamp line, so every `00:00:04.763` counted as "reference words".
   The score read **42.53%**; the true figure is **1.25%**. A wrong measuring
   instrument is indistinguishable from a wrong implementation.
2. **`classifyEnding` swallowed a sentence end.** A `^\d+\.$` guard meant to
   spare numbered-list markers made `"…the streets are after 10."` non-final, so
   it was glued onto the next sentence. Nothing about "after 10." is a list.
   Removed; the decimal cases it was protecting (`3.14`, `v2.0`) are already
   safe because their period is not the last character.
3. **The special-token regex required a trailing `_`.** `[_BEG_]` matched;
   `[_TT_242]` did not, so all 44 timestamp tokens leaked into the text.

### 15.7 Reachability, revised

§9's table needs two corrections. Both were found the hard way:

- **`curl` needs `--http1.1` on this machine.** Against `ghfast.top`,
  `cdn.jsdelivr.net` and `hf-mirror.com`, plain `curl` hangs until timeout; with
  `--http1.1` all three answer. A HEAD request is also rejected where a ranged
  GET succeeds, so probe with `-r 0-1023`, never `-I`.
- **hf-mirror.com stalls mid-transfer.** It served the 82 MB model happily, then
  died silently at 110 MB of the 856 MB one — connection open, zero bytes/s.
  Resumable + stall-aborting is required: `curl -C - --speed-time 45
  --speed-limit 20000 --retry 40 --retry-all-errors`.

Confirmed working (HTTP 206 via ranged GET):

| What | Route |
|---|---|
| whisper.cpp binary (CPU) | `ghfast.top/https://github.com/ggerganov/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip` |
| model weights | `hf-mirror.com/ggerganov/whisper.cpp/resolve/main/<ggml-*.bin>` |
| **Silero VAD weights** | `hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin` |
| `cdn.jsdelivr.net` | timed out here (worked when measured in §9 — treat as flaky) |

### 15.8 Verification log additions

- `npm run typecheck` — clean
- `npm test` — **107 passing** (was 59, then 100)
- `npm run bench:asr -- --models base.en-q8_0,large-v3-turbo-q8_0` — fixture, VAD on:

| Model | Time | WER | cue-start median | signed mean | cue-end signed mean |
|---|---|---|---|---|---|
| `base.en-q8_0` | 7.9 s (15.7×) | 1.00% | **102 ms** | **+39 ms** | −293 ms |
| `large-v3-turbo-q8_0` | 58.0 s (2.13×) | 1.00% | 555 ms | **−517 ms** | — |

  The signed column is what made the turbo problem visible at all; a median of
  absolute values cannot distinguish a noisy 100 ms from a settled 550 ms.
  The −293 ms cue-end bias is a **convention difference** (the hand-made VTT makes
  its cues contiguous; we end a cue at the last word's real acoustic end), not
  drift — the harness now says so in its own output.
- 38 cues vs the reference's 36, WER **1.00%** (4 edits / 401 words).
- the 3 "extra" cues are `"Mostly, the weather…"`, `"A sentence I could read in
  three seconds goes by in one."` and `"Let the sentence finish and then go
  back."` — all genuine sentences in the source text that the **hand-made VTT had
  merged**. The count difference is the reference being coarser, not the
  segmenter being wrong. Worth a human read to confirm.
- the 4 text edits are `belong→belonged`, `ear→ears`, `stopped→stop`,
  `so→while`, and `practising→practicing` (a spelling variant, not an error)

**Caveat that matters for M1's acceptance:** this is clean neural TTS with no
music, noise or accent. It is the easiest possible input, so 1% is a
best case, not an expectation. §16's acceptance bar (3 video types, under 5%)
still needs real material.

**Second caveat, added in §15.10:** on this fixture *every* cue start lands
exactly on a whisper segment boundary, so the cue-start number is scoring
`offsets.from` alone and the token timeline is never exercised. A good number
here is not evidence about the interior alignment. The harness now prints this
coincidence explicitly.

### 15.9 Still open

- **Silero VAD is exercised now (§15.10)** — and it does not mean what it first
  looked like it meant; the whole timeline needs translating.
- **Hallucination filtering is not implemented** — see §15.3 for what is and is
  not possible.
- **Real material is still untested.** Everything here is one 124 s neural-TTS
  fixture, and §15.10 shows it cannot even exercise the interior token timeline.
  M1's actual bar (3 kinds of video, under 5% WER, segmentation read line by
  line) is untouched until there is a real video.
- **The cue-end convention is decided but not yet felt.** We end cues at the last
  word's real end; the reference VTT makes them contiguous. Both are defensible;
  a 300 ms gap between lines may read as deliberate (the line dims during the
  pause) or as a glitch. Needs a human ear once there is real audio.
- M1 steps 3–5 (embedded-subtitle extraction, job runner + SSE, UI wiring) have
  not been started. `segment.ts` and `whisper.ts` are the two hardest pieces and
  they are done and tested.

### 15.10 The VAD timeline split — 2026-09-24

The regression that mattered, and the one finding on this project that no amount
of unit testing would have produced. It is worth reading before touching
`whisper.ts`.

**Symptom.** Turning `--vad` on — step ④ of the designed pipeline, so it is on by
default — took cue-start error from a median **48 ms** to **~900 ms** (turbo
992 ms, base 885 ms). Text was perfect throughout. Only the *times* moved, and
they moved in a way that grew through the file.

**Cause.** `--vad` makes whisper.cpp recognise a *concatenation of the speech
chunks*. So there are two timelines in one JSON:

- token `t_dtw` / `offsets` describe position **within speech** — every silence
  in the file has been deleted from this counter;
- each segment's own `offsets` stay in **original audio** time, and VAD actually
  makes them *better* (segment 0 reports 740 ms against a hand-checked 700 ms,
  where without VAD the same segment claimed 0 ms).

The first cue was off by ~700 ms and every later cue by all the silence skipped
so far. The tell is the coverage ratio:

| Run | token timeline end / audio end |
|---|---|
| no VAD | **0.9998** |
| `--vad` | **0.9470** |

That single ratio is now what `whisper.ts` uses to warn when the `vad` flag
disagrees with the data it was handed — a wrong flag silently corrupts every
timestamp, so it is checked rather than trusted.

**The fix, and the wrong fix.** The obvious reconciliation is a linear rescale of
each segment's tokens onto `[offsets.from, offsets.to]`. It is wrong, and the
measurement says so twice:

| Evidence | Value | What it rules out |
|---|---|---|
| shift `offsets.from − posFirst`, segment 0 → last | 700 ms → **6420 ms**, monotonic | a *global* offset |
| stretch `audioSpan / tokenSpan` | median **1.094** | a *rescale* |

Silence removal **deletes** time; it does not change speaking rate. So a segment's
inter-token durations must survive untouched, and the correct map is a pure
**translation per segment** by `offsets.from − posFirst`. The rescale would have
stretched every gap by 9.4% — inaudible in a WER check, wrong in a player.

Alternatives were measured rather than argued. Chaining a segment's first word to
the previous segment's last boundary is **worse** (base 178 ms, turbo 983 ms), so
`offsets.from` stays as the seed.

**The known cost.** With only one anchor, a segment's first word lands on its own
start and has no measurable duration. Pinned down in `whisper.test.ts` as a
documented consequence, and absorbed by `segment.ts`'s existing degenerate-span
normalisation — not papered over with an invented minimum.

**Two things this changed in the tooling, both because the old metric lied:**

1. `bench-asr.ts` reported only a *median of absolute* boundary errors. That
   cannot separate "noisy but honest" from "systematically early", and those need
   opposite responses. It now reports **signed** means, and cue ends as well as
   starts. Turbo's −517 ms bias was invisible before and obvious after.
2. It now reports how many cue starts coincide with a segment boundary. On this
   fixture: **38/38**. So the cue-start number was only ever scoring
   `offsets.from`, and the token timeline — the entire point of `-dtw` — was
   going unmeasured. A harness that cannot see the thing you are fixing is how
   the first "fix" got through.

**The model conclusion.** `large-v3-turbo-q8_0` puts its VAD segments ~550 ms
early on *every* cue (signed mean −517 ms, median −555 ms), while being 7× slower
and no more accurate. `base.en-q8_0` is unbiased (+39 ms signed) at 15.7× real
time. **Default to `base.en-q8_0`**; keep turbo available but not as a default,
and do not build a Vulkan toolchain for it.

**The honest limitation.** Because 38/38 cue starts sit on segment boundaries,
this fixture *cannot* score the interior token timeline at all. The translation
is justified by the two measurements above and by what VAD physically does — not
by the fixture agreeing with it. Real material is what will test it, and until
then the interior mapping should be described as reasoned, not validated.

## 16. M1 steps 4–5: the pipeline, run and wired — 2026-09-24

Step 3 was dropped (§9 step 3), which left the job runner, the API and the UI.
All three are done, and the pipeline now runs end to end from the UI, from the
API and from the command line.

### 16.1 `lib/server/asr.ts` — finding the tools

Two things it deliberately does **not** contain.

**No model list.** `scripts/install-tools.mjs` needs one — it has to know
filenames and expected sizes in order to download. The *runner* must not, because
a duplicated table is a table that drifts: the installer gains a model and the
runner keeps insisting it does not exist. So the runner looks at the disk and
derives the rest from the filename it finds. `ggml-large-v3-turbo-q8_0.bin` →
`large.v3.turbo` (strip the quantisation suffix, dashes to dots), because that is
forced by whisper.cpp's own naming: weight files are dashed, DTW tables are
dotted.

That derivation is then **validated against the set of names whisper.cpp actually
accepts**, and this is the part that earns its keep: `distil-large-v3-q5_0`
derives cleanly to `distil.large.v3`, which is not a real DTW table. Passing it to
`-dtw` fails deep inside the engine, where it reads as a corrupt model rather than
a bad argument. Resolution now refuses it up front, with a message that says why.

**No hard failure for an optional part.** Missing Silero weights drop `--vad` and
add a warning, rather than refusing the job — the same posture as ffprobe.

### 16.2 Progress: `-pp` is off by default

The transcription stage is 80% of the wait, so a bar that sits still through it
is not a progress bar. This was the most valuable measurement of the session, and
it went the wrong way three times before it went right:

| Hypothesis | Measurement | Verdict |
|---|---|---|
| whisper prints `progress = N%` | 131 stderr lines on the 124 s fixture; the only `%` is the VAD sample-reduction message | **absent** |
| the decoded-segment stdout lines track progress | 28 lines arrived in **one burst at 1.93 s** of a 7.2 s run, max timestamp 28.4 s of 122 s | not streaming, not usable |
| there is a flag | `-pp, --print-progress [false  ]` | **this is it** |

With `-pp`: five real progress lines (22 / 46 / 70 / 94 / 100%) on a 6.8 s run.
The parser was right all along; the flag was missing. So `buildWhisperArgs` is a
pure function with its own tests, and `-pp` has a test whose comment explains
that nothing else in the invocation reveals it is off.

**ffmpeg, by contrast, needed no discovery** — `-progress pipe:1` works and emits
`out_time=00:00:30.000188`. It parses `out_time` and not `out_time_ms`: that key
is named in milliseconds, has always carried microseconds, and older builds
disagree about it on top of that. `out_time` is a timestamp, so it means one
thing. (`.5` is half a second, not 5 ms — there is a test, because reading it the
other way makes the bar lurch.)

### 16.3 The runner

`lib/server/transcribe.ts`. Stages: `queued → probing → extracting →
transcribing → assembling → segmenting → writing → done`, plus `failed` and
`cancelled` as separate terminal states.

**Full snapshots, not deltas.** Every change publishes the complete job. That
makes the SSE endpoint trivially correct — a client connecting late, or
reconnecting after a socket drops, is immediately right — and no replay buffer
exists to get out of sync. A few hundred bytes per frame on loopback with one
user; the usual argument for deltas does not apply.

**A cancelled job is not a failed one.** They are reached the same way (a thrown
error) but need opposite things from the user, so they are distinguished by an
explicit flag rather than by string-matching an error message.

**The pipeline is an injected list of steps.** `executeJob` owns stages, progress
arithmetic and cancellation; the steps own ffmpeg and whisper. That split is what
makes the risky part — a process-spawning state machine — testable in
milliseconds with fake steps, including the two properties the UI leans on:
percentages never go backwards, and a stage that cannot measure itself still
spends its full share of the bar.

Progress weights are `2 / 8 / 80 / 5 / 3 / 2` (sum 100, asserted in a test), so
the bar reflects where the time actually goes.

Cancellation kills the child process, not just a flag — otherwise whisper.cpp
keeps burning a core until it finishes the file, which the user experiences as
"cancel does nothing". A cancel arriving between `spawn` and registration is
handled by re-checking once the child is tracked.

### 16.4 The API and the CLI

```
POST   /api/transcribe              -> 202 + job
GET    /api/transcribe              -> all jobs (or the live one for ?lessonId=)
GET    /api/transcribe/<id>         -> one snapshot
GET    /api/transcribe/<id>?stream=1-> text/event-stream of snapshots
DELETE /api/transcribe/<id>         -> cancel
```

Refusals map onto the status that describes them rather than a blanket 400:
`409 has-transcript` (with the real line count), `409 already-running` (with the
job id to attach to instead), `404 no-such-lesson`, `422 no-audio`, `503
toolchain` (with the command that fixes it). The UI does something different for
each, so flattening them would throw away information the client needs.

`bin/transcribe.ts` drives the identical runner with no UI in the loop — which is
how this whole step was developed and debugged. It accepts a lesson id, an
unambiguous prefix, a title substring, or a path (matched by content
fingerprint), plus `--all-missing` for a batch.

### 16.5 The UI

`hooks/useTranscribeJob.ts` + `components/transcribe/TranscribePanel.tsx`, used
in two places: inline in a library row (`compact`) and as the content of the
player when there is no transcript (`full`). The repeat/pause bar is hidden when
there are no lines, rather than offering controls that do nothing.

Two details that would otherwise be bugs:

- **Reattach on mount.** The job id is never stored in the browser; the panel
  asks the server what is running for this lesson. A progress strip that vanishes
  on refresh is worse than none.
- **Close the `EventSource` on a terminal frame.** `EventSource` reconnects
  automatically on *any* close, including a deliberate one, so a finished job
  would otherwise be re-requested in a loop for as long as the page stays open.

### 16.6 Two bugs found by running it

1. **`sink.isCancelled is not a function`.** The executor had been narrowed to a
   small `JobSink` interface and `startTranscription` was still passing the whole
   `JobRuntime`. The unit tests construct the sink directly, so they could not see
   it; the end-to-end run saw it immediately. `tsc` would also have caught it —
   which is the lesson: **typecheck before the acceptance run, not after.**
2. **`Module not found: Can't resolve 'fs'`.** `TranscribePanel` imported
   `STAGE_LABELS` — a *value* — from `lib/server/transcribe.ts`, which pulled
   `repo` → `db` → `better-sqlite3` → `fs` into the browser bundle. The error
   names a SQLite binding and points nowhere near the mistake. Fixed by moving the
   stage vocabulary to `lib/lesson/stages.ts`, which now has no imports at all.
   Promoted to invariant #3, because it is the mirror image of the rule that
   already existed and it will happen again otherwise.

### 16.7 Verification log additions

- `npm test` — **155 passing** (was 107; 157 after §17); `npm run typecheck` clean
- **CLI, end to end** on the 124 s fixture (a re-muxed copy with no sibling
  subtitle), `base.en-q8_0` + VAD: **10.64 s wall** including Node startup, and
  **38 cues / 401 words** — the same 38 cues `bench:asr` reports, which is the
  cross-check that the CLI path and the bench path are the same path.
- The written `lesson.json` was inspected: `source: "asr"`, `engine:
  "whisper.cpp"`, `model: "base.en-q8_0"`, `vad: true`, `wordTimestamps: true`,
  segmentation recorded, cue starts monotonic, zero degenerate spans, first cue at
  740 ms (the §15.10 VAD segment-0 value).
- **HTTP acceptance**, four cases, all pass:
  A. refusing to clobber a 8-line transcript → `409 has-transcript` + remedy
  B. a real job followed over SSE → 12 frames, `transcribing → … → done`,
     percents monotonic ending at 100
  C. reattach (`GET ?lessonId=`) mid-run → the live job at 28% / "Transcribing — 22%"
  D. `DELETE` mid-run → stage `cancelled` with `error: null`, and the lesson's cue
     count unchanged at 38 — a cancel does not corrupt what was already there
- **UI smoke test** (server-rendered HTML): the library shows the Transcribe
  button for a lesson with no transcript; `/watch/<id>` with no cues shows
  "No transcript yet" and the header reads "no transcript"; a lesson *with* cues
  still renders the repeat bar. Clicking through it is a **human check** — see
  §16.8.

### 16.8 Still open

- **The progress strip has never been watched by a human.** The HTML is right and
  the SSE frames are right, but "does the bar feel honest during a two-minute
  wait" is a judgement, not a measurement. Import a file with no subtitle and
  press Transcribe.
- **No real-world material has been transcribed.** Everything measured is the
  synthetic fixture: neural TTS, no music, no noise, one accent. §15.8's caveat
  applies in full — 1.0% WER is a best case, not an expectation. The M0
  acceptance criterion ("listen for 20 minutes without wanting to stop") is still
  waiting on a human ear too.
- **The reattach path is per-page, not global.** The library and the player each
  poll for the job they care about; there is no single place that lists running
  jobs. A job started from the CLI is invisible to the browser until it finishes.
- **One job at a time is enforced per lesson, not globally.** Two different
  lessons can transcribe at once, and on this CPU that means they each get slower.
  Unknown whether it matters; a queue would be the fix if it does.
- **`.ass` is still unsupported**, and image-based subtitle codecs (PGS/VobSub)
  are now called out explicitly in the ingest warning, since the export command we
  recommend only works for text-based ones.

## 17. "Previous line" did not go to the previous line — 2026-09-24

Reported by the user after using the arrows: *"上一句其实是跳到当前这句开头，下一句是正常的."*
Exactly right, and the code said so out loud:

```ts
// If we are more than 400ms into the current line, restart it instead of
// stepping back one — this matches how people expect "back" to behave.
return timeMs - cues[index].start > 400 ? index : index - 1
```

### Why it was written that way, and why it was still wrong

The 400 ms rule is the media-player convention: pressing "back" mid-track
restarts the track. It makes sense where a track is minutes long and restarting
is a cheap way to "hear that again".

It is the wrong trade here, for three reasons:

1. **It is position-dependent, so the key looks broken.** Mid-line it does
   nothing. The helper is only reached when the playhead is already in a line
   and, for lines longer than 400 ms, every press from the first 400 ms onward
   returned the current index. Measured on the fixture: **131 of 271** sampled
   in-line positions behaved that way — 48%, so this was the common case, not an
   edge case.
2. **It made the two arrows asymmetric.** `→` always advanced; `←` sometimes
   stood still. Two adjacent buttons that behave by different rules read as a
   bug even when each is defensible alone.
3. **Replaying a line already has two affordances**: clicking the line in the
   transcript (`handleSelect` seeks to its start), and `Repeat → Line`, which
   loops it until you stop. The transport buttons do not need to do it too.

### The fix

`findPreviousCueIndex` is now strictly the line before the one the playhead is
in, clamped at the first — a mirror of `findNextCueIndex`:

```ts
if (index <= 0) return 0
return index - 1
```

The **test that pinned the old behaviour had to be deleted**, not adjusted. It
read `it('restarts the current line when we are already into it')` and asserted
`findPreviousCueIndex(cues, 3000) === 1` — the bug, written down as a
requirement. This is the second time in this project that a test memorialised
the defect (§15.10 was the first, in `classifyEnding`). Two occurrences is a
pattern: **when a test asserts behaviour nobody can point at in the product, the
test is the suspect, not the code.**

Replaced with the two properties that actually matter:
- *never restarts the current line, however far into it we are* — offset 2999
  and 6999 on the test cues, i.e. deliberately past the old threshold
- *prev and next are each other's inverse at line granularity* — from every line
  start, `←` gives `i-1` and `→` gives `i+1`, and `→` then `←` returns to the
  line we left

### `npm run verify:step`

The unit test has three synthetic 1-second cues. A **position-dependent** bug
needs realistic line lengths, so the property that failed is verified against
the real fixture instead, as a named entry point rather than a throwaway script
(the convention from §15.10): 36 lines / 123.3 s, sweeping **8 depths inside
every line** — `0, 1, 100, 400, 401, 1000, 3000, span-1`, which straddles the
old 400 ms boundary on purpose.

It also re-runs the identical sweep against the old rule as a **control**:

```
fixture: 36 lines, 123.3s
  checked 271 in-line offsets
ALL PASS
control: the old rule gets 131/271 of the same offsets wrong
```

A check that passes for both the broken and the fixed implementation would be
worthless; the control is what makes the green run mean anything.

**The harness was wrong first.** An earlier version of the sweep used a fixed
`+3000 ms` offset for every line and reported nine failures. The fixture's cues
are back-to-back — each `end` is the next `start` — so `+3000 ms` regularly
lands two lines further on and the expectation, not the function, was wrong.
Third time in this project that the measuring instrument was the defect (§15.10's
WER scorer, §16's missing `-pp`). **When the numbers look wrong, suspect the
instrument before the code.**

### Also in this pass

- **The ±5 s buttons are gone** and `←`/`→` step lines. Four transport buttons
  were only two intents: for 2–4 s lines "back 5 s" lands near the previous line
  and "forward 5 s" near the next. The line buttons are the better pair — they
  align to cue starts, reset the repeat counter, scroll the transcript and honour
  *Play on click*. Anything finer is the scrub bar or clicking a transcript line.
  The arrow handler ignores events from form controls (loop count, speed, volume
  all own the arrows), passes modifiers through, and respects `defaultPrevented`.
- **`npm run tools:install` defaulted to the wrong model.** It staged
  `large-v3-turbo-q8_0` (834 MB) while `lib/server/asr.ts` asks for
  `base.en-q8_0` (78 MB) — so a new user downloaded a model the app would not
  pick, and one §15.10 had already rejected as 7× slower for no accuracy gain.
  The defaults now agree. Note the shape of this: `asr.ts` was built without a
  model list *specifically* to avoid drifting from the installer, and the drift
  happened in the installer instead. **Anti-drift has to cover every copy of the
  fact, not just the file you were worried about.**
- **README caught up with M1**: transcription (UI + every `npm run transcribe`
  flag, checked against the CLI source), what `tools:install` really stages and
  through which proxies, model sizes and the English-only caveat, a keyboard map.
  The *"Not built yet: speech recognition"* line was stale. Also clarified what
  is and is not in git: `bin/` (both CLI entry points) **is** tracked; `tools/`
  is not, by design — the binaries are large and reproducible with one command.

### Verification log additions

- `npm test` — **157 passing** (was 155; `findActiveCue.test.ts` 18 → 20)
- `npm run typecheck` — clean
- `npm run verify:step` — ALL PASS, with the control at 131/271 as above
- `npm run tools:install -- --list` — smoke-tested after the default change
- SSR HTML of `/watch/<id>` re-fetched: *Back 5 seconds* / *Forward 5 seconds*
  absent, *Previous line (←)* / *Next line (→)* present
- **Not verified by a human:** the arrow keys themselves. They are client-side
  and SSR HTML cannot show them; the evidence is typecheck plus the pure-function
  sweep. Worth a keystroke the next time the player is open.

### Decision (user, 2026-09-24): replay-current-line stays as-is

Asked whether a dedicated "replay this line" key (e.g. `R`) was wanted now that
`←` always steps back a line. **Answer: no.** Replay keeps its two existing
affordances — clicking a line in the transcript, and `Repeat → Line`. No new
key, and `←` stays strictly "previous line". This closes §17; nothing pending
from the arrow-key work except the human keystroke check above.

## 18. M1 step 6: download from a URL — 2026-09-28

Requested by the user: *"a box where I can paste a YouTube URL (or another
site's, later), that downloads the video locally and then continues with the
same series of operations"*, calling into a `youtube-dl` checkout they had
already cloned.

The second half of that sentence is the whole design. "Then continues with the
same series of operations" means **the download is a way of producing a file,
not a second pipeline** — so the feature is a decorator in front of
`ingestFile()`, and everything after it (probing, subtitles, the player,
transcription, progress memory) is untouched and unaware. Verified: the
`lesson.json` a URL download produces is field-for-field the shape a local
import produces.

### 18.1 The downloader is optional, and that shapes the code

`youtube-dl` is a Python program on this machine only because the user cloned
it; it is not something the app can assume. So resolution is a ladder, tried in
order, and *the app works fine with none of them present* — the URL box is the
only thing that stops working:

1. `tools/downloader/<kind>/` — the copy `npm run downloader:install` stages
2. a `youtube_dl` / `yt_dlp` module importable by a Python we found
3. a `youtube-dl` / `yt-dlp` console script on `PATH`

`yt-dlp` is tried before `youtube-dl` when both are present: it is the
maintained fork and fixes extractors that break when a site changes. The two are
**not** flag-compatible, so the flag set is chosen per tool (§18.7).

### 18.2 `lib/server/download-tools.ts` — resolution, and nothing else

Pure Node, no `next/*` (invariant #2), no side effects beyond spawning the
tools it is asking about. Three jobs:

- **Find a Python that works.** Candidates come from config, then `python` /
  `python3` / `py`, then a glob sweep. Each is asked to import the downloader
  module *and* to print its version, so "present but broken" is distinguished
  from "absent". `pythonCandidates()` takes the configured list as a parameter
  rather than reading config itself, which is what makes the ladder testable.
- **Resolve a proxy.** `"auto"` (the default) tries, in order: the
  `https_proxy`/`http_proxy` environment variables, the Windows registry, then
  the common local proxy ports. Every candidate is *health-checked against the
  host the download will actually reach* before being accepted (§18.7).
- **Build and parse.** Every flag is verified against the tool's own `--help`,
  and the `[download] 42.1% of 12.34MiB at 1.2MiB/s ETA 00:05` progress line is
  parsed into structured progress.

### 18.3 `lib/server/download.ts` — the job runner

Modelled directly on `transcribe.ts`, because that runner's shape was already
right and there is no reason for a second one:

- In-memory registry hung off `globalThis` (survives a dev-server HMR reload)
- **Full snapshot publishes, never deltas** (invariant #8) — a client that
  connects late is immediately correct with no replay buffer
- Cancellable by killing the child process
- The risky part (the step sequence) is injected, so the state machine is
  testable without spawning anything

Three stages with weights that sum to 100: `probing` (5) → `downloading` (90) →
`importing` (5). The narrow first slice is deliberate: metadata and the proxy
health check are the parts most likely to fail, and reporting 5% immediately
tells the user the toolchain works before the long wait starts.

The `importing` stage calls `ingestFile({ path, managed: isInside(mediaPath,
managedMediaDir), onProgress })`. That `managed` flag is the interesting part —
see §18.7.

### 18.4 The API

`app/api/download/route.ts` (list, start, dedupe) and
`app/api/download/[jobId]/route.ts` (snapshot, SSE stream, cancel). Same SSE
contract as transcription: `?stream=1`, first frame is the current state, the
stream closes on a terminal stage. Status codes are mapped from the problem
kind: `400` bad URL, `409` already running, `503` no downloader, `500` nowhere
to save.

Two behaviours worth naming:

- **Starting the same URL twice is a no-op, not a second download.** `POST`
  returns `409` with the *existing* `jobId` attached, so the client reattaches
  instead of erroring at the user. `GET ?url=` answers the same question for a
  page that just loaded.
- **The URL is stored in `localStorage` and reattach happens on mount**, so a
  reload mid-download does not orphan a running job. The hook detaches on a
  terminal frame, specifically to stop `EventSource` from reconnecting forever
  to a job that is already finished.

### 18.5 The UI

`components/ingest/UrlDownloadPanel.tsx`, sat directly under the local import
panel — the two entry points read as one list of ways to get a video in. The
progress bar shows the server's number verbatim; there is no client-side
interpolation, because a bar that animates smoothly while the download is
actually stalled is a lie. The completed state offers **Open it**, which is a
link to `/watch/<lessonId>` — the ordinary lesson page, because that is what it
is.

The panel also carries an *"also fetch the site's captions"* checkbox, on by
default. When the site has a subtitle track, the lesson is readable the instant
the download finishes — no transcription, and no whisper run at all. That is
the difference between a 30-second and a 4-minute wait for a 19-second clip.

### 18.6 The CLI and the installer

`npm run fetch -- <url>` drives the same `startDownload` the route does, for the
same reason `bin/ingest.ts` exists: when a download fails, having no browser in
the loop is the difference between a diagnosis and a guess. `--doctor` prints
the downloader, the resolved proxy, and the health-check result.

`scripts/install-downloader.mjs` stages a copy into `tools/` in three steps:
`--from <dir>` (copy a checkout you name, which is how the user's existing clone
gets used), then an already-importable module, then `git clone` through
`ghfast.top`. `tools/` is gitignored, so the clone is reproducible rather than
committed.

### 18.7 Six things this cost real time to learn

All measured on this machine, 2026-09-28. Each one is recorded because each one
produced a failure that *looked like something else*.

**1. `spawnSync` fails with `EBUSY` — always.** All four variants
(`spawnSync('python', [...])`, with an explicit path, with `shell: true`, via
`child_process.execFileSync`) fail the same way, including from a plain Node
script with nothing else running. The consequence is nasty: a synchronous probe
does not throw where you would notice, it returns an empty result — so python
discovery and the registry read both answered *"nothing here"* while Python sat
on disk at a path the code had already computed. **This is now invariant #11**,
and `lib/server/run-process.ts` is the only place that spawns anything.
Async `spawn` is unaffected, in the same environment, on the same call.

**2. A TCP connect is not a proxy check.** This machine has a proxy at
`127.0.0.1:52389` that accepts connections and is a real proxy — it is the
sandbox's own egress proxy — but answers `502 Bad Gateway` / times out for
`www.youtube.com`, because it only permits a fixed set of hosts. The real one is
`127.0.0.1:7897`. A port-open check puts `52389` at the *top* of the candidate
list and every download then fails with a 502 that names neither the proxy nor
the port, and reads exactly like the site blocking you. So the check is a real
`CONNECT host:443` round trip, sent to **the host the download will actually
use**. The resolved-proxy line in `--doctor` now answers "works for this site?"
in one line. The rejected candidate is reported rather than silently dropped,
because the user may recognise it:

```
proxy       : http://127.0.0.1:7897 (probe)
! Ignored unusable proxy setting(s): http://127.0.0.1:52389 [env] — timed out.
checked via : www.youtube.com:443
```

**3. An unconnected socket holds no handle, and the process exits silently.**
The first version of `probeProxyConnect` built the socket, wrote the `CONNECT`
line, and awaited the response — but never called `socket.connect()`. Nothing
kept the event loop alive, so the process drained and **exited 0 with no
output**, which reads as "the check passed". It now calls `connect()` before
writing, with a comment, because the failure mode is invisible in review: the
code *looks* like it makes a request.

**4. yt-dlp and youtube-dl do not share flags, and youtube-dl fails hard.**
`--print` and `--no-convert-subs` are yt-dlp-only; passing either to youtube-dl
is not ignored, it is `error: no such option` and exit. (`--print` is worse: it
is *ambiguous* with `--print-json` / `--print-traffic`, so the error message
does not name the real problem.) Two consequences: the flag set is chosen per
tool, and metadata is fetched with `-J` / `--dump-json`, which both accept. All
17 flags in the final arg builder were checked against `youtube-dl --help`
individually.

**5. `HTTP_PROXY` in caps is ignored; lowercase wins.** `urllib`'s
`getproxies()` only reads the lowercase spellings. The resolution order is
therefore `EL_DOWNLOAD_PROXY` (explicit override) → lowercase → uppercase, and
**`--proxy` is always passed explicitly**, even when a proxy came from the
environment — because youtube-dl omitting it falls back to reading the Windows
registry itself, which reintroduces exactly the stale-entry 502 the whole proxy
layer exists to prevent. Belt and braces, on purpose: the app's own resolution
and the downloader's must not disagree.

**6. A blocked program throws synchronously from `spawn`.** `reg.exe` is on the
sandbox's program blacklist, and the block does not arrive as an `error` event —
it **throws `EPERM` out of the `spawn()` call itself**, inside the Promise
executor, where it becomes a rejection unless caught. Every `spawn` in the
download path is therefore wrapped in `try`/`catch` that resolves a "could not
run it" result instead of rejecting. The registry is one *candidate source*, not
a requirement, so its absence degrades to "one fewer hint" and never to a
failure.

### 18.8 `managed: true` — the first time it has ever been true

Invariant #7 says the app never deletes a user's file, with one exception:
media it copied itself (`managed === 1`). Until this feature, **that exception
had never actually fired.** Everything was imported by path and read in place,
`managed` was always `0`, and `removeLesson`'s managed-media branch was dead
code in practice.

A URL download is that case, and it is the honest reason the branch exists:
nobody else on the machine has a copy of that file, so deleting the lesson must
delete the media, or the user has an invisible growing folder. The ingest call
passes `managed` explicitly, and it is computed with an `isInside()` check
against the managed media dir rather than assumed — because `--out` can point
the downloader at a directory the user owns, and a file inside the *user's*
folder must not become deletable just because we downloaded it.

This is the one place where the download feature changes a behaviour outside
itself, so it is called out here and in the README ("a downloaded file becomes
ours"). The lesson page's remove dialog is the same dialog as always; it now
has a case where the answer is genuinely different.

### 18.9 Verification log additions

- `npm test` — **219 passing** (was 157; `lib/server/download-tools.test.ts`
  adds 62)
- `npm run typecheck` — clean
- `npm run build` — passes (see the note below)
- `npm run fetch -- --doctor <url>` — `checked via : www.youtube.com:443`;
  picks `127.0.0.1:7897` and reports `52389` as rejected
- **End to end, via `bin/fetch.ts`:**
  ```
  downloader: youtube-dl (tools/downloader/youtube-dl)
      5%  Downloading
     95%  Downloading · Me at the zoo
     95%  Adding to the library · Locating the file
    100%  Done · 6 lines from sidecar-vtt
    done
    Me at the zoo (youtube)
    D:\…\data\media\jNQXAC9IVRw.m4a
    6 lines from sidecar-vtt
    open: http://127.0.0.1:4317/watch/5f350c864d04
  ```
  Resulting `lesson.json`: `managed: true`, `source: sidecar-vtt`, `cues: 6`,
  `durMs: 19064`, `hasAudio: true`, `hasVideo: false`.
- **End to end, through HTTP** (dev server on `:4317`): `GET /api/download` →
  `{jobs:[]}`; `POST` a malformed URL → `400` `{code:'bad-url'}`; `POST` a real
  URL → `202` + job; `GET ?url=` → the same job; `GET /<id>?stream=1` → SSE
  frames that walk `probing` → `downloading` → `importing` → `done`;
  `DELETE /<id>` → `{cancelled:true}` and the job reaches `cancelled`; a second
  `POST` of an in-flight URL → `409` + the existing `jobId`. The ghost-proxy
  rejection shows up in the job's `warnings`, so the UI can surface it.
- Re-downloading the same URL reuses the existing lesson — no orphan row.
- Cancelling left no `.part` / `.ytdl` residue in `data/media`.

Note on `next build`: it emits a Turbopack warning for any `path.resolve()` the
tracer cannot statically scope, because it then assumes the whole project may be
reachable and inlines it. `config.ts` already carried the fix idiom
(`/* turbopackIgnore: true */`, with the reasoning written above
`findProjectRoot`) — the two new downloader paths needed the same hint. Worth
remembering that the tracer's own advice is to *silence* these once you know the
access is intentional: the warning it prints is long, and it buries real
warnings underneath it.

### 18.10 Still open

- **The panel needs a human eye** (§7 item 5). The API is verified; nobody has
  typed in the box.
- **Only YouTube is measured as a source** (§7 item 6).
- **A stalled download and a slow one look the same.** The bar shows the
  server's percent, so a transfer that has genuinely hung sits at 45% and says
  `Downloading` forever. `--socket-timeout 30` bounds each read, but a
  mid-transfer hang is not covered. A "no progress for N seconds" warning would
  fix it; not built.
- **`--max-height` has no UI.** The API and the CLI take it; the panel only
  offers audio-only vs video. Fine for now — the default (720p) is what a
  listening tool wants, and video is the exception.
- **No download history.** Only `activeJobForUrl` and `listJobs` exist, both
  memory-only, so a finished download is forgotten on restart. The *lesson*
  persists, which is what matters, but "what did I download last week" is
  unanswerable. Not needed yet; noted because the data is already in
  `lessons/`.


