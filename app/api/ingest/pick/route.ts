import { spawn } from 'node:child_process'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/ingest/pick -> open the OS file dialog and return the chosen
 * ABSOLUTE PATH.
 *
 * Why this exists: pasting a long Windows path with spaces and non-ASCII
 * characters by hand is error-prone. The browser's own picker cannot help
 * here, because a web page is never told the real path of a file it reads --
 * which is exactly the value the rest of this pipeline is built around.
 *
 * The request blocks until the dialog closes (or the timeout fires). For a
 * single-user localhost app that trade-off is fine and keeps the UI simple.
 */

const DIALOG_TIMEOUT_MS = 5 * 60_000

const FILTER_LABEL =
  'Media files|*.mp4;*.m4v;*.mkv;*.webm;*.mov;*.avi;*.flv;*.wmv;*.mpg;*.mpeg;*.ts;*.mp3;*.m4a;*.aac;*.flac;*.wav;*.ogg;*.opus|Video files|*.mp4;*.m4v;*.mkv;*.webm;*.mov;*.avi|Audio files|*.mp3;*.m4a;*.wav;*.flac;*.ogg;*.opus|All files|*.*'

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // windowsHide keeps a console window from flashing up. The dialog itself is
    // a separate GUI window, so it still appears.
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The file dialog was left open for too long and was closed.'))
    }, DIALOG_TIMEOUT_MS)

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
      resolve({ stdout, stderr, code })
    })
  })
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Windows PowerShell writes to a redirected stream in the OEM codepage, which
# turns any error text we capture into mojibake. Force UTF-8 before anything is
# written so diagnostics stay readable.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import a video or audio file'
$dialog.Filter = '${FILTER_LABEL}'
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
# OpenFileDialog has NO TopMost property - that belongs to Form. Assigning it
# threw PropertyAssignmentException, and with ErrorActionPreference=Stop the
# script died on that line before the dialog could ever be shown. That is why
# clicking Browse appeared to do nothing at all.
#
# Deliberately NO owner form either: a modal dialog owned by a minimised Form is
# refused by Windows and ShowDialog returns immediately, so "owner + Minimized"
# silently reproduced the same no-op. Called with no owner, the process has no
# foreground window of its own and Windows grants the dialog the foreground, so
# it comes up in front of the browser.
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
`

/**
 * `diagnostic` is set only when the dialog could not be shown at all.
 *
 * "The user cancelled" and "the dialog silently failed to appear" both produce
 * no path, and collapsing them into one `cancelled: true` response is how this
 * endpoint came to look like a dead button: the exit code and stderr were being
 * discarded, so a broken dialog was reported as a polite cancellation.
 */
type PickOutcome = { path: string | null; diagnostic: string | null }

function summarise(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine
}

async function pickOnWindows(): Promise<PickOutcome> {
  const { stdout, stderr, code } = await runCommand('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-Command',
    WINDOWS_SCRIPT,
  ])
  const picked = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
  if (picked.length > 0) return { path: picked, diagnostic: null }

  if (code !== 0 || stderr.trim().length > 0) {
    return {
      path: null,
      diagnostic:
        summarise(stderr) || `The file dialog process exited with code ${String(code)}.`,
    }
  }
  return { path: null, diagnostic: null }
}

async function pickOnMac(): Promise<PickOutcome> {
  const script = 'POSIX path of (choose file with prompt "Import a video or audio file")'
  const { stdout, stderr, code } = await runCommand('osascript', ['-e', script])
  const picked = stdout.trim()
  if (picked.length > 0) return { path: picked, diagnostic: null }
  // osascript reports a user cancel as a non-zero exit with "User canceled" on
  // stderr, so only treat other failures as diagnostics.
  if (code !== 0 && !/user cancel/i.test(stderr)) {
    return { path: null, diagnostic: summarise(stderr) || `osascript exited with ${String(code)}.` }
  }
  return { path: null, diagnostic: null }
}

async function pickOnLinux(): Promise<PickOutcome> {
  const failures: string[] = []
  for (const [command, args] of [
    ['zenity', ['--file-selection', '--title=Import a video or audio file']],
    [
      'kdialog',
      [
        '--getopenfilename',
        '.',
        'Media files (*.mp4 *.mkv *.webm *.mov *.mp3 *.m4a *.wav *.flac)',
      ],
    ],
  ] as const) {
    try {
      const { stdout, stderr, code } = await runCommand(command, [...args])
      if (stdout.trim()) return { path: stdout.trim(), diagnostic: null }
      if (code !== 0) failures.push(`${command}: ${summarise(stderr) || `exit ${String(code)}`}`)
      else return { path: null, diagnostic: null } // clean exit, no selection = cancel
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    path: null,
    diagnostic: failures.length > 0 ? failures.join(' | ') : null,
  }
}

export async function POST() {
  try {
    let outcome: PickOutcome

    if (process.platform === 'win32') outcome = await pickOnWindows()
    else if (process.platform === 'darwin') outcome = await pickOnMac()
    else outcome = await pickOnLinux()

    if (outcome.diagnostic) {
      console.error('[api/ingest/pick] dialog failed', outcome.diagnostic)
      return NextResponse.json(
        {
          path: null,
          cancelled: false,
          error: `Could not open the system file dialog. ${outcome.diagnostic} — type or paste the path instead.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ path: outcome.path, cancelled: outcome.path === null })
  } catch (error) {
    console.error('[api/ingest/pick] failed', error)
    return NextResponse.json(
      {
        path: null,
        cancelled: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not open the system file dialog. Type or paste the path instead.',
      },
      { status: 500 },
    )
  }
}
