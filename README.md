# English Listening

A local, single-user English listening trainer. Point it at a video, get a
per-sentence transcript you can click, loop, and sit on — the transcript scrolls
in sync with playback like lyrics, and clicking a line jumps the video to it.

Runs entirely on this machine. No accounts, no uploads, no internet.

## Quick start

```bash
npm install
npm run tools:install   # stages ffmpeg + ffprobe + whisper.cpp + a transcription model + Silero VAD into ./tools
npm run fixture         # generates testmedia/listening-fixture-01.mp4 (optional)
npm run dev             # http://127.0.0.1:4317
```

Then either paste a video's path into the library page, or:

```bash
npm run ingest -- "F:\videos\ep01.mp4"
```

If a matching `.srt` or `.vtt` file sits next to the video, it is picked up
automatically and the video is playable immediately.

## Transcription

No subtitles? Transcribe the audio locally — nothing leaves the machine.

- **In the app:** open a lesson with no transcript and press **Transcribe**. A
  progress bar tracks the job; you can leave the page and come back.
- **From the command line:**

  ```bash
  npm run transcribe -- "F:\videos\ep01.mp4"   # by path, or a lesson id, or a title substring
  npm run transcribe -- --list                 # what is staged
  npm run transcribe -- --all-missing          # every lesson without a transcript
  ```

The default model is `base.en-q8_0` (78 MB, English-only, measured unbiased and
~15x real time on the target machine). It is what `npm run tools:install`
downloads. For other languages use `--model large-v3-turbo-q8_0` (834 MB,
multilingual) in both tools:install and transcribe — on this machine it measured
7x slower with no accuracy gain, so it is not the default.

Downloads go through the `ghfast.top` (GitHub) and `hf-mirror.com` (model
weights) proxies because the usual hosts are not reachable directly; the install
script resumes a stalled download automatically. `tools/` is gitignored — the
binaries are large and reproducible with the one command above.

## What it does today

- Import a file by path (or through the native file dialog), from the web UI or
  the command line — both go through the same pipeline
- Per-sentence transcript with sync highlighting and auto-scroll
- Click a line to seek there; repeat one line, or repeat it N times
- **Transcribe a file with local whisper.cpp** — one click in the UI, or
  `npm run transcribe`; progress is live and cancellable
- Slow playback down to 0.6x with the pitch preserved
- Remembers where you stopped in each file

Not built yet: favourites, translation, subtitle editing, `.ass` subtitles.
See [PROGRESS.md](./PROGRESS.md) for exact status.

## Two things worth knowing

**Your files are read in place.** Nothing is copied, moved, renamed or deleted.
The only directory this app writes to is its own `data/`. Removing a lesson from
the library removes the app's own transcript and progress, not your video. If you
later move or rename the file, re-import it from the new location — the lesson is
recognised by content fingerprint and re-pointed, keeping the transcript.

**Import is explicit.** There is no folder scanning and no background watching.
You name a file, it gets imported; nothing else happens.

## Docs

| File | What |
|---|---|
| [`PROGRESS.md`](./PROGRESS.md) | Build status, architecture invariants, what to do next. **Read this before contributing.** |
| `../docs/listening-app-design.md` | The full product and technical design, with the reasoning behind each decision |
| [`testmedia/README.md`](./testmedia/README.md) | What the test fixture is and why it is synthesised |

## Layout

```
app/              pages + API routes (Range streaming lives in api/media/[id])
components/       player, transcript, ingest UI
hooks/            usePlaybackClock (the frame clock), useAutoScroll (scroll lock)
lib/lesson/       schema, VTT/SRT parsing  — pure, testable
lib/sync/         active-line lookup       — pure, testable
lib/server/       ingest + transcription pipeline, ffprobe, SQLite, range parsing (no next/* here)
bin/ingest.ts     CLI front door for the same ingest pipeline
bin/transcribe.ts CLI front door for the transcription job runner
scripts/          tool staging + test-fixture generation
```

## Keyboard

| Key | Action |
|---|---|
| `←` / `→` | previous / next line (same as the two line buttons) |

Arrows are ignored while a form control (loop count, speed, volume) has focus —
those own the arrows for their own purpose.

## Requirements

Node 20+ (22 tested). Windows is the target platform — one feature, the native
file dialog, is Windows-specific and falls back to a plain path input elsewhere.
