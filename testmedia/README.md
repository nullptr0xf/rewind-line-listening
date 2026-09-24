# testmedia

Test material for the player. Everything here is generated locally — nothing is
downloaded, and no third-party footage is involved.

## Files

| File | In git? | What it is |
|---|---|---|
| `listening-fixture-01.mp4` | no | Video + speech, 2:03, 1-second keyframes |
| `listening-fixture-01.vtt` | **yes** | Sidecar subtitle, timed to the millisecond |
| `<name>.wav` | no | Intermediate, only produced by the `espeak` backend |

The `.mp4` is gitignored because it is a regenerable binary; the `.vtt` is
tracked on purpose, because it is a hand-checked fixture.

## What the current fixture is

36 sentences of a first-person monologue about learning to listen: 401 spoken
words, 2:03 in total, 3.24 words per second averaged over the whole file with the
pauses included. Nothing is slowed down for the learner — that is what the
player's speed control is for.

## Why synthetic instead of a real film

Two reasons, and the second one matters more than the first:

1. The usual open-movie mirrors are unreachable from this machine.
2. A synthetic fixture is a **stronger** test. Speech is synthesised in one
   request with word-boundary reporting switched on, so the engine hands back
   the exact onset and duration of every spoken word. The subtitle is built by
   grouping those words back into the sentences they came from — so the cue
   times are *measured from the audio*, not estimated.

   If the highlighted line and the spoken sentence ever disagree, that is a bug
   in the player. There is no ambiguity about what the "correct" timing is.

## The picture

Soft "ruled paper" in the app's own mint palette, with the **actual audio** drawn
across it as a scrolling waveform (`showwaves`, the app's accent colour at 60%
alpha) and a small caption naming the fixture and the voice. The waveform is
information, not decoration: you can see a sentence begin and end, see the pause
between sentences, and see that a seek landed where you meant. During silence the
line is flat, so "is anything playing?" is answerable from across the room.

It replaced ffmpeg's `testsrc` test pattern, which read as "no signal" — the one
message a picture must never send in a player. The trade is worth naming: the old
pattern burnt a frame counter into the frame, which made the *exact* timestamp
visible; the new one shows audio shape instead, which is the thing this app is
actually about. Timestamps are in the transport, where they always were.

The background is generated per pixel in this script (a dependency-free PNG
writer), so the picture is reproducible from code with no binary assets.

The video is encoded with `-g 25 -keyint_min 25 -sc_threshold 0` on purpose:
exactly one keyframe per second, which is the "practice proxy" recommendation in
the design doc. So this file is a fair test of seek latency rather than a
best case.

## Two backends

| `--tts` | Voice | Needs network? | Good for |
|---|---|---|---|
| `edge` *(default)* | Microsoft Edge read-aloud neural voices | yes | Judging whether listening is **pleasant** |
| `espeak` | eSpeak NG (WASM), a dev-only dependency | no | Offline; judging sync only — it is robotic |

Both produce a subtitle, both produce an `.mp4`. Only `edge` can also report
word boundaries, which is what makes its timings measured rather than computed.

`edge` is a reverse-engineered client for the endpoint Edge's own Read Aloud
uses. It is unofficial, unauthenticated and free, which is fine for a local test
fixture and would not be fine for a shipped product. **Nothing at runtime
depends on it**: the generated `.mp4` and `.vtt` are ordinary local files, so
the app works with the network off, forever.

## Regenerating

```bash
npm run tools:install                        # ffmpeg + ffprobe into ./tools
npm run fixture                              # rewrites the .mp4 and the .vtt
npm run fixture -- --sentences 8             # a short one, for quick checks
npm run fixture -- --voice en-GB-RyanNeural  # a different accent
npm run fixture -- --rate -10%               # slower, for a beginner pass
npm run fixture -- --list-voices             # what is available
npm run fixture -- --tts espeak              # fully offline fallback
```

If `edge` cannot be reached, the error says so and names `--tts espeak` as the
way out. If you are behind an egress proxy, try `--no-proxy`.

Regenerating **replaces the file in place**, which means its content fingerprint
changes and the old library entry no longer matches the media. Re-import, and
remove the previous entry:

```bash
npm run ingest -- "testmedia/listening-fixture-01.mp4"
```

## Importing it

```bash
npm run ingest -- "testmedia/listening-fixture-01.mp4"
```

The `.vtt` is discovered automatically because it sits next to the video and
shares its basename — the same path a real sidecar subtitle would take.
