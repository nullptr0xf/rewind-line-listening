import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Run a child process, handing each output line to a callback.
 *
 * Shared by the transcription runner and the download runner. It lives here
 * rather than in either of them because the behaviour below is subtle enough
 * that two copies would drift, and a bug in it is invisible: you would just see
 * a progress bar that stops, or an error message that says nothing.
 *
 * Deliberately does NOT accumulate full output. whisper.cpp narrates every
 * segment it decodes and youtube-dl narrates every DASH fragment; holding either
 * for a 45-minute file is pure waste. Only a bounded tail of STDERR is kept —
 * stdout carries machine chatter (`progress=end`, `[download] …`) and would
 * otherwise drown the messages that matter.
 *
 * Pure Node: no `next/*` import.
 */

/** Longest we keep of a child's stderr. */
const STDERR_TAIL_BYTES = 4096

export type RunProcessOptions = {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  /** Called with the live child, so a cancel can reach it. */
  onSpawn?: (child: ChildProcess) => void
  /** Working directory. Needed when the command is `python -m <package>`. */
  cwd?: string
}

export type RunProcessResult = {
  /** Process exit code; -1 when it was killed by a signal. */
  code: number
  stderrTail: string
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
    })
    options.onSpawn?.(child)

    let stderrTail = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''

    /** Split complete lines out of a buffer, returning the incomplete remainder. */
    const drain = (buffer: string, line: (value: string) => void) => {
      const parts = buffer.split(/\r?\n/)
      const rest = parts.pop() ?? ''
      for (const part of parts) line(part)
      return rest
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      stdoutBuffer = drain(stdoutBuffer, options.onStdout ?? (() => {}))
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      stderrBuffer += chunk
      stderrBuffer = drain(stderrBuffer, options.onStderr ?? (() => {}))
    })

    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderrTail }))
  })
}

/** The last few non-empty lines of a child's stderr — where the real error is. */
export function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ')
}
