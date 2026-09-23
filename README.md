# English Listening

A local, single-user English listening trainer. Point it at a video, get a
per-sentence transcript you can click, loop, and sit on — the transcript scrolls
in sync with playback like lyrics, and clicking a line jumps the video to it.

Runs entirely on this machine. No accounts, no uploads, no internet.

## Quick start

```bash
npm install
npm run tools:install   # stages ffmpeg + ffprobe into ./tools
npm run fixture         # generates testmedia/listening-fixture-01.mp4 (optional)
npm run dev             # http://127.0.0.1:4317
```

Then either paste a video's path into the library page, or:

```bash
npm run ingest -- "F:\videos\ep01.mp4"
```

If a matching `.srt` or `.vtt` file sits next to the video, it is picked up
automatically and the video is playable immediately.

## What it does today

- Import a file by path (or through the native file dialog), from the web UI or
  the command line — both go through the same pipeline
- Per-sentence transcript with sync highlighting and auto-scroll
- Click a line to seek there; repeat one line, or repeat it N times
- Slow playback down to 0.6x with the pitch preserved
- Remembers where you stopped in each file

Not built yet: speech recognition (that is M1), favourites, translation,
subtitle editing. See [PROGRESS.md](./PROGRESS.md) for exact status.

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
app/            pages + API routes (Range streaming lives in api/media/[id])
components/     player, transcript, ingest UI
hooks/          usePlaybackClock (the frame clock), useAutoScroll (scroll lock)
lib/lesson/     schema, VTT/SRT parsing  — pure, testable
lib/sync/       active-line lookup       — pure, testable
lib/server/     ingest pipeline, ffprobe, SQLite, range parsing (no next/* here)
bin/ingest.ts   CLI front door for the same ingest pipeline
scripts/        tool staging + test-fixture generation
```

## Requirements

Node 20+ (22 tested). Windows is the target platform — one feature, the native
file dialog, is Windows-specific and falls back to a plain path input elsewhere.
