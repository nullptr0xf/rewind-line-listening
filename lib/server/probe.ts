import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_TOOLS_DIR, loadConfig } from './config'
import type { EmbeddedSubtitle } from '../lesson/schema'

/**
 * ffprobe wrapper.
 *
 * IMPORTANT: ffprobe is optional at this stage. Machines without it must still
 * be able to import a video and play it — the <video> element knows the
 * duration, it just cannot enumerate embedded subtitle streams. So a missing
 * binary produces a degraded but usable result, never a hard failure.
 */

export type ProbeAudioInfo = {
  codec: string | null
  channels: number | null
  sampleRate: number | null
}

export type ProbeResult = {
  available: boolean
  toolPath: string | null
  durationMs: number | null
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  audio: ProbeAudioInfo | null
  embeddedSubtitles: EmbeddedSubtitle[]
  error: string | null
}

type FfprobeStream = {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  channels?: number
  sample_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

type FfprobeOutput = {
  streams?: FfprobeStream[]
  format?: { duration?: string; format_name?: string }
}

export type ToolName = 'ffprobe' | 'ffmpeg'

export function toolCandidates(name: ToolName): string[] {
  const config = loadConfig()
  const toolsDir = config.toolsDir || DEFAULT_TOOLS_DIR
  const explicit = name === 'ffprobe' ? config.ffprobePath : config.ffmpegPath

  const list: string[] = []
  if (explicit) list.push(path.resolve(explicit))

  const exe = `${name}.exe`
  list.push(path.join(toolsDir, exe))
  list.push(path.join(toolsDir, name))
  // Last resort: rely on PATH resolution by spawning the bare name.
  list.push(name)

  return list
}

/** Absolute path of a usable tool, or null when it is not installed anywhere we look. */
export function findTool(name: ToolName): string | null {
  for (const candidate of toolCandidates(name)) {
    if (candidate === name) {
      // Not a path — assume PATH lookup is possible and let the spawn decide.
      return null
    }
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function isMissingBinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'EACCES'
}

function runFfprobe(toolPath: string, absPath: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      toolPath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        absPath,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`ffprobe timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`))
    })
  })
}

function toProbeResult(toolPath: string, json: FfprobeOutput): ProbeResult {
  const streams = json.streams ?? []

  const videoStream = streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  )
  const audioStream = streams.find((stream) => stream.codec_type === 'audio')
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle')

  const durationSeconds = Number(json.format?.duration ?? Number.NaN)

  return {
    available: true,
    toolPath,
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? null,
          channels: audioStream.channels ?? null,
          sampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
        }
      : null,
    embeddedSubtitles: subtitleStreams.map((stream) => ({
      streamIndex: stream.index ?? -1,
      codec: stream.codec_name ?? null,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
    })),
    error: null,
  }
}

function unavailable(reason: string): ProbeResult {
  return {
    available: false,
    toolPath: null,
    durationMs: null,
    width: null,
    height: null,
    hasVideo: true,
    hasAudio: true,
    audio: null,
    embeddedSubtitles: [],
    error: reason,
  }
}

export async function probeFile(absPath: string): Promise<ProbeResult> {
  let lastError: unknown = null

  for (const candidate of toolCandidates('ffprobe')) {
    try {
      const stdout = await runFfprobe(candidate, absPath)
      return toProbeResult(candidate, JSON.parse(stdout) as FfprobeOutput)
    } catch (error) {
      if (isMissingBinary(error)) {
        lastError = error
        continue
      }
      // The tool exists but could not read the file: report it, do not retry.
      const message = error instanceof Error ? error.message : String(error)
      return { ...unavailable(message), toolPath: candidate, available: false }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? '')
  return unavailable(
    `ffprobe was not found (looked in tools/ and PATH). Duration and embedded-subtitle detection are unavailable. ${detail}`.trim(),
  )
}
