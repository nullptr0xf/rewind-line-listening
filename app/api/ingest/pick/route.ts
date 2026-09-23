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
    const child = spawn(command, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })

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
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Import a video or audio file'
$dialog.Filter = '${FILTER_LABEL}'
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$dialog.TopMost = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
`

async function pickOnWindows(): Promise<string | null> {
  const { stdout } = await runCommand('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-Command',
    WINDOWS_SCRIPT,
  ])
  const picked = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ''
  return picked.length > 0 ? picked : null
}

async function pickOnMac(): Promise<string | null> {
  const script = 'POSIX path of (choose file with prompt "Import a video or audio file")'
  const { stdout } = await runCommand('osascript', ['-e', script])
  const picked = stdout.trim()
  return picked.length > 0 ? picked : null
}

async function pickOnLinux(): Promise<string | null> {
  try {
    const { stdout } = await runCommand('zenity', [
      '--file-selection',
      '--title=Import a video or audio file',
    ])
    return stdout.trim() || null
  } catch {
    const { stdout } = await runCommand('kdialog', [
      '--getopenfilename',
      '.',
      'Media files (*.mp4 *.mkv *.webm *.mov *.mp3 *.m4a *.wav *.flac)',
    ])
    return stdout.trim() || null
  }
}

export async function POST() {
  try {
    let picked: string | null = null

    if (process.platform === 'win32') picked = await pickOnWindows()
    else if (process.platform === 'darwin') picked = await pickOnMac()
    else picked = await pickOnLinux()

    return NextResponse.json({ path: picked, cancelled: picked === null })
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
