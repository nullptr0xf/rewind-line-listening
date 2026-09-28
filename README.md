# English Listening

A local, single-user English listening trainer. Point it at a video, get a
per-sentence transcript you can click, loop, and sit on — the transcript scrolls
in sync with playback like lyrics, and clicking a line jumps the video to it.

Runs entirely on this machine: no accounts, no uploads, no server of anyone
else's. Two things reach out to the network, and only when you ask them to —
downloading a video from a URL, and transcribing with a model you have already
fetched. Everything else is local.

## Quick start

```bash
npm install
npm run tools:install        # stages ffmpeg + ffprobe + whisper.cpp + a transcription model + Silero VAD into ./tools
npm run downloader:install   # optional: stages the URL downloader, so you can paste a link instead of a path
npm run fixture              # generates testmedia/listening-fixture-01.mp4 (optional)
npm run dev                  # http://127.0.0.1:4317
```

Then either paste a video's path (or a video URL) into the library page, or:

```bash
npm run ingest -- "F:\videos\ep01.mp4"
npm run fetch  -- "https://www.youtube.com/watch?v=..."
```

If a matching `.srt` or `.vtt` file sits next to the video, it is picked up
automatically and the video is playable immediately.

## Downloading from a URL

Paste a link into **Or paste a video URL** on the library page and it downloads
the audio (or the picture), then hands the file to the same pipeline a local
import uses — so what you get is an ordinary library entry: playable, loopable,
transcribable, re-openable.

```bash
npm run fetch -- "https://www.youtube.com/watch?v=..."   # audio only, the default
npm run fetch -- <url> --video --max-height 720          # keep the picture
npm run fetch -- <url> --no-captions                     # ignore the site's own subtitles
npm run fetch -- <url> --out "F:\videos"                 # save somewhere other than data/media
npm run fetch -- --doctor <url>                          # show what it will use, then exit
```

If the site publishes its own subtitle track, it is fetched and used, so the
lesson is readable the moment the download finishes — no transcription needed.
If it does not, the lesson imports with no transcript and you can press
**Transcribe** as usual. Downloading the same URL twice reuses the existing
lesson rather than making a second copy.

`npm run downloader:install` stages the downloader into `./tools/downloader` so
the app is self-contained. If you would rather use an install you already have,
it will find one on `PATH` or importable by your Python — the bundled copy is
just tried first. yt-dlp works too and is preferred when both are present; note
that yt-dlp and youtube-dl take *different* flags, so the app picks the flag set
per tool.

### If the download fails

Almost every failure on a machine like this one is the proxy, not the site.

```bash
npm run fetch -- --doctor <url>
```

prints the downloader it found, the proxy it will use, and — this is the useful
part — actually opens a tunnel to the site's host through that proxy before
claiming it works. A proxy that is running but does not carry your site shows up
here instead of as a `502` three minutes into a download.

By default `downloader.proxy` is `"auto"`: it tries the `HTTPS_PROXY`/`HTTP_PROXY`
environment variables, then the Windows registry, then the usual local proxy
ports, and keeps the first one that can really reach the site. Explicit values in
`ingest.config.json`:

| Value | Meaning |
|---|---|
| `"auto"` | Try env → registry → common ports, health-check each (default) |
| `"none"` | Never use a proxy; connect directly |
| `"http://127.0.0.1:7897"` | Use exactly this proxy |

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
- **Download a video from a URL** — paste a link, watch it download, and it lands
  in the library as an ordinary lesson; the site's own subtitles are used when
  they exist, so it is often readable before you finish reading this
- Per-sentence transcript with sync highlighting and auto-scroll
- Click a line to seek there; repeat one line, or repeat it N times
- **Transcribe a file with local whisper.cpp** — one click in the UI, or
  `npm run transcribe`; progress is live and cancellable
- Slow playback down to 0.6x with the pitch preserved
- Remembers where you stopped in each file

Not built yet: favourites, translation, subtitle editing, `.ass` subtitles.
See [PROGRESS.md](./PROGRESS.md) for exact status.

## Three things worth knowing

**Your files are read in place.** Nothing is copied, moved, renamed or deleted.
The only directory this app writes to is its own `data/`. Removing a lesson from
the library removes the app's own transcript and progress, not your video. If you
later move or rename the file, re-import it from the new location — the lesson is
recognised by content fingerprint and re-pointed, keeping the transcript. (A
downloaded file is the one exception — see below.)

**Import is explicit.** There is no folder scanning and no background watching.
You name a file — or paste a URL — and it gets imported; nothing else happens.

**A downloaded file becomes ours.** A URL import is the one case where the app
owns the media: it writes into `data/media/`, and removing the lesson deletes
that file, because nothing else on the machine has a copy. Files you imported by
path are still never touched.

## Docs

| File | What |
|---|---|
| [`PROGRESS.md`](./PROGRESS.md) | Build status, architecture invariants, what to do next. **Read this before contributing.** |
| `../docs/listening-app-design.md` | The full product and technical design, with the reasoning behind each decision |
| [`testmedia/README.md`](./testmedia/README.md) | What the test fixture is and why it is synthesised |

## Layout

```
app/                  pages + API routes (Range streaming lives in api/media/[id])
components/           player, transcript, ingest UI
hooks/                usePlaybackClock (the frame clock), useAutoScroll (scroll lock)
lib/lesson/           schema, VTT/SRT parsing  — pure, testable
lib/sync/             active-line lookup       — pure, testable
lib/server/           ingest + transcription + download pipelines, ffprobe, SQLite,
                      range parsing (no next/* here)
lib/server/download-tools.ts  finds a downloader, resolves a proxy, parses progress
lib/server/download.ts        the download job: download → the same ingest as a local file
bin/ingest.ts         CLI front door for the same ingest pipeline
bin/transcribe.ts     CLI front door for the transcription job runner
bin/fetch.ts          CLI front door for the download job runner
scripts/              tool staging + test-fixture generation
tools/                staged binaries (gitignored, reproducible via the two install scripts)
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
