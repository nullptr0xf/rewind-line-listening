# testmedia

Test material for the player. Everything here is generated locally — nothing is
downloaded, and no third-party footage is involved.

## Files

| File | In git? | What it is |
|---|---|---|
| `listening-fixture-01.mp4` | no | Video + speech, 1-second keyframes |
| `listening-fixture-01.vtt` | **yes** | Sidecar subtitle, timed to the millisecond |
| `tts/` | no | Scratch directory for the synthesiser |

The `.mp4` is gitignored because it is a regenerable binary; the `.vtt` is
tracked on purpose, because it is a hand-checked fixture.

## Why synthetic instead of a real film

Two reasons, and the second one matters more than the first:

1. This machine cannot reach the usual open-movie mirrors (Cloudflare blocks
   `download.blender.org`, and GitHub is unreachable).
2. A synthetic fixture is a **stronger** test. Each sentence is rendered
   separately, so its exact duration is read back from the WAV header, and the
   subtitle is generated from the same numbers the audio was built from. If the
   highlighted line and the spoken sentence ever disagree, that is a bug in the
   player — there is no ambiguity about what the "correct" timing is.

The picture is ffmpeg's `testsrc`, which burns a running frame counter into the
frame. That makes seek behaviour visible: you can see the timestamp the player
thinks it is at, next to what the audio is actually saying.

The video is encoded with `-g 25 -keyint_min 25 -sc_threshold 0` on purpose:
exactly one keyframe per second, which is the "practice proxy" recommendation in
the design doc. So this file is a fair test of seek latency rather than a
best case.

## Regenerating

```bash
npm run tools:install     # ffmpeg + ffprobe into ./tools (from the npm registry)
npm run fixture           # rewrites the .mp4 and the .vtt
npm run fixture -- --sentences 60 --name listening-fixture-02
```

Speech comes from `espeak-ng` (the WASM build), a dev-only dependency used to
generate audio. It is a robotic voice, deliberately: crisp word boundaries make
timing problems easy to hear. It is not part of the shipped app.

## Importing it

```bash
npm run ingest -- "testmedia/listening-fixture-01.mp4"
```

The `.vtt` is discovered automatically because it sits next to the video and
shares its basename — the same path a real sidecar subtitle would take.
