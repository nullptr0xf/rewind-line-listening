import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DEFAULT_TOOLS_DIR, loadConfig, type DownloaderConfig, type LoadedConfig } from './config'

/**
 * Locating the URL downloader, choosing a proxy, and reading its output.
 *
 * Pure Node: no `next/*` import, because `bin/fetch.ts` drives this in a plain
 * Node process (same invariant as every other module in lib/server).
 *
 * ## Why this module is not three lines
 *
 * The obvious implementation is `spawn('youtube-dl', [url])`. It does not work
 * on the machine this app targets, for three separate reasons that each produce
 * a confusing failure:
 *
 * 1. **youtube-dl is a Python package, not a binary here.** The conventional
 *    install is `pip install`, but what this project actually has is a source
 *    checkout that the interpreter finds through sys.path. So the command shape
 *    varies: `python -m youtube_dl`, or a bundled copy, or a console script.
 *
 * 2. **`--print` does not exist** in youtube-dl (that is a yt-dlp addition).
 *    Passing it aborts with `error: ambiguous option: --print (--print-json,
 *    --print-traffic?)`. Metadata therefore comes from `-J` / `--dump-json`.
 *
 * 3. **The proxy is a trap.** When `--proxy` is omitted, youtube-dl calls
 *    urllib's `getproxies()`, which on Windows returns whatever is in
 *    `HKCU\...\Internet Settings` — regardless of `HTTP_PROXY` in the
 *    environment. A leftover Clash entry pointing at a port nothing listens on
 *    turns every download into `Tunnel connection failed: 502 Bad Gateway`,
 *    which reads like YouTube blocking you. Measured on the target machine:
 *    the registry held a dead `127.0.0.1:52389` while the live proxy was
 *    `127.0.0.1:7897`, and the same URL failed or succeeded purely on whether
 *    `--proxy` was passed.
 *
 * So: resolve the toolchain, resolve the proxy, and always pass `--proxy`
 * explicitly. Everything below is ordered so the cheap, certain checks come
 * first and the expensive ones (spawning an interpreter) only run when needed.
 */

// --- the downloader ----------------------------------------------------------

/** Both projects are CLI-compatible for everything this app does. */
export type DownloaderKind = 'youtube-dl' | 'yt-dlp'

/** The importable package name for each kind. */
export const MODULE_NAME: Record<DownloaderKind, string> = {
  'youtube-dl': 'youtube_dl',
  'yt-dlp': 'yt_dlp',
}

/** Directory name under `tools/downloader/` for a bundled copy. */
export const BUNDLE_DIR_NAME: Record<DownloaderKind, string> = {
  'youtube-dl': 'youtube-dl',
  'yt-dlp': 'yt-dlp',
}

/** yt-dlp is preferred when both are present: it is the maintained one. */
const KIND_ORDER: DownloaderKind[] = ['yt-dlp', 'youtube-dl']

export type DownloaderCandidate = {
  kind: DownloaderKind
  /** The interpreter to spawn. */
  command: string
  /** Leading args, e.g. `['-m', 'youtube_dl']` for a module invocation. */
  prefix: string[]
  /**
   * Directory that must be the process cwd for `-m <module>` to resolve. This
   * is how a bundled copy is used with no install and no PYTHONPATH fiddling:
   * `python -m X` puts the cwd on sys.path.
   */
  cwd: string | null
  /** Where this candidate came from, for the diagnostics the user actually reads. */
  origin: string
}

export type ResolvedDownloader = DownloaderCandidate & {
  version: string
}

export type DownloaderProblem = {
  kind: 'missing-python' | 'missing-downloader'
  message: string
  remedy: string
}

export type DownloaderResolution =
  | { ok: true; downloader: ResolvedDownloader; notes: string[] }
  | { ok: false; problem: DownloaderProblem }

const PROBE_TIMEOUT_MS = 20_000

export type CaptureResult = {
  /** True only for a clean exit. */
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** `ENOENT` and friends; null when the process actually ran. */
  spawnError: string | null
  timedOut: boolean
}

/**
 * Run a command and collect its output.
 *
 * Async `spawn`, deliberately not `spawnSync`. Measured in this project's own
 * environment: **every** `spawnSync` call fails with `EBUSY`, in all four
 * variants tried (with and without `windowsHide`, with and without `shell`, bare
 * name or absolute path), while the identical command through async `spawn`
 * returns exit 0 immediately. A synchronous probe is therefore not just
 * inconvenient here, it is broken — and it fails *silently*, because the error
 * lands in `result.error` rather than being thrown, so a naive caller reads it
 * as "the tool is not installed".
 */
export function runCapture(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: CaptureResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    let timer: ReturnType<typeof setTimeout>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // `spawn` reports a missing binary through the 'error' event, but a policy
      // block (EPERM) is thrown synchronously — inside a Promise executor that
      // becomes a rejection, and an unhandled one takes the whole caller down.
      // A probe that cannot run is a "no", never a crash.
      const code = (error as NodeJS.ErrnoException).code ?? String(error)
      resolve({ ok: false, code: null, stdout, stderr, spawnError: code, timedOut: false })
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code ?? error.message
      finish({ ok: false, code: null, stdout, stderr, spawnError: code, timedOut })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, spawnError: null, timedOut })
    })
  })
}

/**
 * Ask one interpreter what it is and which downloader packages it can import.
 *
 * One spawn answers both questions, because two spawns would double the cost of
 * a check that runs before every single download.
 */
export async function probePython(command: string): Promise<{
  exe: string
  version: string
  modules: Record<DownloaderKind, boolean>
} | null> {
  const script = [
    'import importlib.util, json, sys',
    "mods = {m: bool(importlib.util.find_spec(m)) for m in ('youtube_dl', 'yt_dlp')}",
    "print(json.dumps({'exe': sys.executable, 'version': sys.version.split()[0], 'mods': mods}))",
  ].join('; ')

  const result = await runCapture(command, ['-c', script])
  if (!result.ok || !result.stdout) return null

  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{'))
  if (!line) return null

  try {
    const parsed = JSON.parse(line) as {
      exe: string
      version: string
      mods: Record<string, boolean>
    }
    return {
      exe: parsed.exe,
      version: parsed.version,
      modules: {
        'youtube-dl': Boolean(parsed.mods.youtube_dl),
        'yt-dlp': Boolean(parsed.mods.yt_dlp),
      },
    }
  } catch {
    return null
  }
}

/**
 * Conventional interpreter locations, expanded from wildcards.
 *
 * A discovery list rather than a hard-coded dependency: the point is to find an
 * interpreter on a machine where `python` is not on PATH, which is the norm in a
 * sandboxed shell and not unheard of in a plain one. Anything found here is
 * still verified by actually running it, so a stale entry costs one failed spawn
 * and nothing else.
 */
const DISCOVERY_ROOTS = [
  'C:/Program Files/Python3*',
  'C:/Program Files (x86)/Python3*',
  'C:/Python3*',
  'C:/Users/*/AppData/Local/Programs/Python/Python3*',
  '/usr/bin/python3*',
  '/usr/local/bin/python3*',
]

/** Expand a glob whose only wildcard is in the final segment. */
export function expandRoot(pattern: string): string[] {
  const segments = pattern.split('/')
  const last = segments.pop()
  if (last === undefined || !last.includes('*')) return []
  const parent = segments.join('/') || '/'

  let entries: string[]
  try {
    entries = fs.readdirSync(parent)
  } catch {
    return []
  }
  const prefix = last.replace('*', '')
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => `${parent}/${entry}`)
}

/** Interpreters to try, in order. Explicit configuration always wins. */
export function pythonCandidates(config: LoadedConfig = loadConfig()): string[] {
  const list: string[] = []
  if (config.downloader.pythonPath) list.push(config.downloader.pythonPath)
  // The Windows launcher (`py`) is listed before the conventional paths because
  // a bare `python` there is very often the Microsoft Store stub, which opens
  // the Store and exits 9009 instead of running anything.
  list.push('python', 'python3', 'py')

  for (const root of DISCOVERY_ROOTS) {
    for (const dir of expandRoot(root)) {
      list.push(`${dir}/python.exe`, `${dir}/python3`, `${dir}/python`)
    }
  }

  return [...new Set(list)]
}

function bundledDir(kind: DownloaderKind, config: LoadedConfig): string | null {
  const configured = config.downloader.directory
  if (configured && path.basename(configured).toLowerCase().includes(kind)) return configured

  const toolsDir = config.toolsDir || DEFAULT_TOOLS_DIR
  const dir = path.join(toolsDir, 'downloader', BUNDLE_DIR_NAME[kind])
  return dir
}

/** A bundled copy is trusted without spawning anything: the file layout says it. */
function isBundled(dir: string, kind: DownloaderKind): boolean {
  return fs.existsSync(path.join(dir, MODULE_NAME[kind], '__init__.py'))
}

/**
 * Find a working downloader, or say precisely what is missing.
 *
 * Order, and the reasoning for it:
 *   1. a copy under `tools/downloader/` — self-contained, survives the source
 *      checkout being deleted, and makes a fresh clone behave identically
 *   2. whatever the interpreter can already import — the common case on this
 *      machine, where the checkout is registered on sys.path
 *   3. a console script named `youtube-dl` / `yt-dlp` on PATH
 */
export async function resolveDownloader(
  options: {
    config?: LoadedConfig
    pythons?: string[]
    probe?: (command: string) => Promise<Awaited<ReturnType<typeof probePython>>>
  } = {},
): Promise<DownloaderResolution> {
  const config = options.config ?? loadConfig()
  const probe = options.probe ?? probePython
  // Explicitly supplied interpreters replace discovery rather than adding to it,
  // so a caller that names them is testing a closed world.
  const pythons = options.pythons ?? pythonCandidates(config)
  const notes: string[] = []

  // 1. bundled
  for (const kind of KIND_ORDER) {
    const dir = bundledDir(kind, config)
    if (!dir || !isBundled(dir, kind)) continue

    for (const python of pythons) {
      const info = await probe(python)
      if (!info) continue
      return {
        ok: true,
        downloader: {
          kind,
          command: info.exe,
          prefix: ['-m', MODULE_NAME[kind]],
          cwd: dir,
          origin: `tools/downloader/${BUNDLE_DIR_NAME[kind]}`,
          version: 'bundled',
        },
        notes,
      }
    }
    notes.push(
      `A bundled ${kind} exists under tools/downloader but no working Python interpreter was found to run it.`,
    )
  }

  // 2. already importable
  for (const python of pythons) {
    const info = await probe(python)
    if (!info) continue
    for (const kind of KIND_ORDER) {
      if (!info.modules[kind]) continue
      return {
        ok: true,
        downloader: {
          kind,
          command: info.exe,
          prefix: ['-m', MODULE_NAME[kind]],
          cwd: null,
          origin: `${MODULE_NAME[kind]} importable by ${info.exe} (Python ${info.version})`,
          version: 'installed',
        },
        notes,
      }
    }
  }

  // 3. a console script. Deliberately last: on Windows a bare name is the one
  //    case where we cannot tell "not installed" from "installed but broken"
  //    without running it.
  for (const kind of KIND_ORDER) {
    const name = kind === 'yt-dlp' ? 'yt-dlp' : 'youtube-dl'
    const found = await probeConsoleScript(name)
    if (!found) continue
    return {
      ok: true,
      downloader: {
        kind,
        command: name,
        prefix: [],
        cwd: null,
        origin: `${name} on PATH`,
        version: found,
      },
      notes,
    }
  }

  let anyPython = false
  for (const python of pythons) {
    if (await probe(python)) {
      anyPython = true
      break
    }
  }

  return {
    ok: false,
    problem: {
      kind: anyPython ? 'missing-downloader' : 'missing-python',
      message: anyPython
        ? 'No video downloader was found. URL import needs youtube-dl (or yt-dlp).'
        : 'No Python interpreter was found, and the downloader needs one.',
      remedy: anyPython
        ? 'npm run downloader:install    # or: pip install yt-dlp'
        : 'Install Python 3, or set downloader.pythonPath in ingest.config.json.',
    },
  }
}

async function probeConsoleScript(name: string): Promise<string | null> {
  const result = await runCapture(name, ['--version'])
  if (!result.ok) return null
  const line = result.stdout.trim().split(/\r?\n/).pop()
  return line || 'unknown'
}

// --- the proxy ---------------------------------------------------------------

/**
 * Local ports worth trying when nothing else is configured.
 *
 * This is the one piece of deliberate magic in the file. The reasoning: this
 * app's whole point is that you paste a URL and it works, and on a machine
 * behind a proxy the alternative is a wall of `502 Bad Gateway` that names
 * neither the proxy nor the port. Ordered most-likely first — Clash's default
 * mixed port, then V2Ray/Xray, then generic.
 */
export const WELL_KNOWN_PROXY_PORTS = [7897, 7890, 10809, 10808, 1080, 8889, 8080]

export type ProxyResolution = {
  /** Null means "pass nothing and let the downloader decide for itself". */
  url: string | null
  /** `none` when the user explicitly asked for no proxy. */
  source: 'config' | 'env' | 'registry' | 'probe' | 'none'
  /** Set when something was found but is not usable — always worth telling the user. */
  warning: string | null
}

/**
 * A TCP connect, because a dead port is the cheapest thing to rule out.
 *
 * Necessary but NOT sufficient — see `probeProxyConnect`.
 */
export function isPortOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

export type ProxyCheck = {
  ok: boolean
  /** Why it was rejected, in words, when it was. */
  reason: string
}

/**
 * Ask the proxy to open a tunnel to the host we are about to download from.
 *
 * This is the check that actually matters, and a TCP connect is not it.
 * Measured on this machine: `127.0.0.1:52389` accepts connections happily — it
 * is a real proxy — but it answers `502 Bad Gateway` for `www.youtube.com`,
 * because it only permits a set of hosts. A port-and-connect check puts it at
 * the top of the candidate list and every download then fails with a 502 that
 * looks like the site blocking you. Issuing the same `CONNECT` that the
 * downloader will issue distinguishes "a listener" from "a usable proxy" in one
 * round trip, and it does so for the *actual target*, so "the proxy works but
 * not for this site" stops being a mysterious failure.
 */
export function probeProxyConnect(
  proxy: { host: string; port: number },
  target: { host: string; port: number },
  timeoutMs = 4000,
): Promise<ProxyCheck> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    let response = ''

    const done = (result: ProxyCheck) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => done({ ok: false, reason: 'timed out' }))
    socket.once('error', (error) =>
      done({ ok: false, reason: (error as NodeJS.ErrnoException).code ?? 'connection failed' }),
    )

    socket.once('connect', () => {
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          'Proxy-Connection: Keep-Alive\r\n\r\n',
      )
    })

    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3}) ?(.*)\r?\n/.exec(response)
      if (!match) return
      const status = Number(match[1])
      if (status >= 200 && status < 300) done({ ok: true, reason: 'tunnelled' })
      else done({ ok: false, reason: `the proxy answered ${status}${match[2] ? ` ${match[2]}` : ''}` })
    })

    // Must come after the listeners, and must not be forgotten: an unconnected
    // Socket holds no handle, so leaving this out makes the event loop drain and
    // the whole process exit *silently* mid-probe — no error, no output, exit 0.
    socket.connect(proxy.port, proxy.host)
  })
}

/** Where to point the reachability check. YouTube is the headline case, and a
 *  proxy that cannot reach it is the one this whole code path exists to catch. */
export const DEFAULT_PROBE_TARGET = { host: 'www.youtube.com', port: 443 }

/** The host a URL will actually be fetched from, for the reachability check. */
export function probeTargetFor(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return DEFAULT_PROBE_TARGET
    return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 443 }
  } catch {
    return DEFAULT_PROBE_TARGET
  }
}

export function parseProxyUrl(raw: string): { host: string; port: number } | null {
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
    const parsed = new URL(withScheme)
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    if (!parsed.hostname || !Number.isFinite(port) || port <= 0) return null
    return { host: parsed.hostname, port }
  } catch {
    return null
  }
}

/**
 * An environment to read proxies from.
 *
 * Not `NodeJS.ProcessEnv`: Next.js augments that with a required `NODE_ENV`, so
 * accepting it would force every caller — and every test — to carry a field
 * nothing here reads.
 */
export type ProxyEnvironment = Record<string, string | undefined>

/** First proxy-looking value in the environment. Lowercase wins, matching urllib. */
export function proxyFromEnv(env: ProxyEnvironment = process.env): string | null {
  const keys = [
    'EL_DOWNLOAD_PROXY',
    'https_proxy',
    'http_proxy',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'all_proxy',
  ]
  for (const key of keys) {
    const value = env[key]
    if (value && value.trim()) return value.trim()
  }
  return null
}

/**
 * Windows' system proxy, read from the registry.
 *
 * Returned but never trusted — the caller health-checks it. This is exactly
 * where the stale entry lives that makes youtube-dl fail on this machine:
 * measured `127.0.0.1:52389`, with nothing listening.
 */
export async function proxyFromWindowsRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

  const enabled = await runCapture('reg', ['query', key, '/v', 'ProxyEnable'], { timeoutMs: 5000 })
  if (!enabled.ok || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled.stdout)) return null

  const server = await runCapture('reg', ['query', key, '/v', 'ProxyServer'], { timeoutMs: 5000 })
  if (!server.ok) return null
  const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(server.stdout)
  if (!match) return null

  // "http=host:port;https=host:port" is a valid ProxyServer value.
  const raw = match[1].trim()
  const pair = /(?:^|;)\s*(?:https|http)=([^;]+)/i.exec(raw)
  return (pair ? pair[1] : raw).trim()
}

/** The three things `downloader.proxy` can mean. */
export const PROXY_AUTO = 'auto'
export const PROXY_NONE = 'none'

/**
 * Decide what to hand to `--proxy`.
 *
 * Three shapes, with deliberately different behaviour:
 *
 *   `"none"`  — a direct connection, and nothing is probed
 *   `"auto"`  — try the environment, then the Windows registry, then the
 *               well-known local ports; use the first that can actually tunnel
 *               to the target host. A candidate that is found but unusable is
 *               reported, never used.
 *   an URL    — use exactly that, or none at all. An explicitly named proxy is
 *               not silently swapped for a different one; if it cannot be used
 *               the user hears about it instead.
 *
 * Two failures made this function necessary, both measured rather than imagined:
 *
 *   1. Omitting `--proxy` makes youtube-dl fall back to urllib's `getproxies()`,
 *      which honours an environment variable the user never set for it. Every
 *      download then fails with `502 Bad Gateway` naming neither the proxy nor
 *      the port.
 *   2. Checking that the port is *open* is not enough. Measured here:
 *      `127.0.0.1:52389` accepts connections and is a real proxy, but answers
 *      502 for `www.youtube.com`. So each candidate is asked to tunnel to the
 *      target host, exactly as the downloader will.
 */
export async function resolveDownloadProxy(
  options: {
    config?: LoadedConfig
    env?: ProxyEnvironment
    /** The site the download will actually fetch from. */
    target?: { host: string; port: number }
    /**
     * Injected for tests. Answers "can this proxy reach the target?" — and
     * replaces the whole two-step default, so a test does no real I/O.
     */
    check?: (proxy: { host: string; port: number }) => Promise<ProxyCheck>
    registry?: () => Promise<string | null>
  } = {},
): Promise<ProxyResolution> {
  const config = options.config ?? loadConfig()
  const env = options.env ?? process.env
  const target = options.target ?? DEFAULT_PROBE_TARGET
  const check =
    options.check ??
    (async (proxy) => {
      // Order matters: a dead port is the common case, and a plain connect is
      // far cheaper than a tunnel attempt that has to wait out a timeout.
      if (!(await isPortOpen(proxy.host, proxy.port))) {
        return { ok: false, reason: 'nothing listening' }
      }
      return probeProxyConnect(proxy, target)
    })
  const registry = options.registry ?? proxyFromWindowsRegistry

  const raw = (config.downloader.proxy ?? '').trim()
  if (raw.toLowerCase() === PROXY_NONE) {
    return { url: null, source: 'none', warning: null }
  }

  const isAuto = raw === '' || raw.toLowerCase() === PROXY_AUTO

  const candidates: { url: string; source: ProxyResolution['source'] }[] = []

  if (!isAuto) {
    candidates.push({ url: raw, source: 'config' })
  } else {
    const fromEnv = proxyFromEnv(env)
    if (fromEnv) candidates.push({ url: fromEnv, source: 'env' })

    const fromRegistry = await registry()
    if (fromRegistry && !candidates.some((entry) => entry.url === fromRegistry)) {
      candidates.push({ url: fromRegistry, source: 'registry' })
    }

    // Last resort, and the reason this app works out of the box on a machine
    // with a proxy running on the usual port and nothing else configured.
    for (const port of WELL_KNOWN_PROXY_PORTS) {
      candidates.push({ url: `http://127.0.0.1:${port}`, source: 'probe' })
    }
  }

  if (candidates.length === 0) return { url: null, source: 'none', warning: null }

  const rejected: string[] = []
  for (const candidate of candidates) {
    const parsed = parseProxyUrl(candidate.url)
    if (!parsed) {
      rejected.push(`${candidate.url} (not a usable proxy URL)`)
      continue
    }
    const result = await check(parsed)
    if (result.ok) {
      const warning =
        rejected.length > 0
          ? `Ignored unusable proxy setting(s): ${rejected.join('; ')}.`
          : candidate.source === 'probe'
            ? `Using the local proxy at ${candidate.url}. Set downloader.proxy in ingest.config.json to make this explicit.`
            : null
      return { url: candidate.url, source: candidate.source, warning }
    }
    rejected.push(`${candidate.url} [${candidate.source}] — ${result.reason}`)
  }

  return {
    url: null,
    source: 'none',
    warning:
      `No usable proxy was found (${rejected.join('; ')}), so this download will go out ` +
      'directly. If the site is blocked, start your proxy or set downloader.proxy in ' +
      'ingest.config.json (use "none" to force a direct connection).',
  }
}

// --- command construction ----------------------------------------------------

export type MediaChoice = {
  /** `audio` takes the best audio stream; `video` keeps the picture. */
  mode: 'audio' | 'video'
  /** Upper bound on picture height; ignored for audio. */
  maxHeight: number
}

export type DownloadRequest = {
  url: string
  /** Absolute path template for `-o`, already containing `%(id)s` / `%(ext)s`. */
  outputTemplate: string
  proxyUrl: string | null
  media: MediaChoice
  /** Download the platform's own caption track as a `.vtt` sidecar. */
  captions: boolean
  language: string
  /** Absolute path to ffmpeg, when one is staged. Only needed to merge streams. */
  ffmpegLocation: string | null
}

/**
 * Format selection, as a pure function.
 *
 * The audio default is not a convenience — it is the point of the feature. A
 * 60-minute lecture is roughly 30 MB of m4a and roughly 600 MB of 1080p video,
 * whisper only ever reads the audio, and this is a listening trainer. The
 * fallback chain matters because not every site offers m4a: `bestaudio/best`
 * catches a webm/opus stream, and a video-only site still yields *something*
 * rather than an error.
 *
 * The video chain is capped at 720p for the same reason: the picture is there
 * for context, and 4K would be minutes of extra download for no study benefit.
 */
export function formatSelector(media: MediaChoice): string {
  if (media.mode === 'audio') {
    return 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'
  }
  const height = Math.max(144, Math.round(media.maxHeight))
  return [
    `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${height}]+bestaudio`,
    `best[height<=${height}]`,
    'best',
  ].join('/')
}

/**
 * Args for the metadata pass.
 *
 * `--simulate` plus `-J` costs one extra round trip to the site, and buys three
 * things the download itself cannot give us: the real title (for the library
 * entry), the duration (for the progress denominator), and an early, cheap
 * failure for a URL that cannot be extracted at all — before a single byte of
 * media has been written.
 *
 * `--no-playlist` is not a preference. A playlist URL would otherwise silently
 * download dozens of files into `data/media`, and a listening trainer teaches
 * one thing at a time.
 */
export function buildMetadataArgs(request: { url: string; proxyUrl: string | null }): string[] {
  const args = ['--simulate', '--dump-json', '--no-playlist', '--no-warnings', '--socket-timeout', '30']
  if (request.proxyUrl) args.push('--proxy', request.proxyUrl)
  args.push(request.url)
  return args
}

export function buildDownloadArgs(request: DownloadRequest): string[] {
  const args = [
    '--newline', // one progress line per update, instead of \r-overwritten
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '30',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '-f',
    formatSelector(request.media),
    '-o',
    request.outputTemplate,
  ]

  if (request.media.mode === 'video') args.push('--merge-output-format', 'mp4')

  if (request.captions) {
    // A caption sidecar is the cheapest possible win: the existing ingest
    // pipeline finds a `.vtt` sitting next to the media by basename, so a
    // lesson with platform captions is playable the moment it lands — no
    // transcription run at all, and the words come from the platform's own
    // model rather than ours.
    //
    // Argument audit, because youtube-dl and yt-dlp are *not* interchangeable
    // flag-for-flag and each difference fails as a hard abort rather than a
    // fallback. Verified against `python -m youtube_dl --help` (2025.04.07):
    // every flag in this file is accepted. Two are not, and both were found the
    // hard way — `--print` (yt-dlp only; here it aborts with "ambiguous option:
    // --print (--print-json, --print-traffic?)") and `--no-convert-subs`
    // (yt-dlp only; "no such option"). Omitting the latter costs nothing:
    // youtube-dl converts subtitles only when `--convert-subs` is given, so
    // `--sub-format vtt` yields vtt directly. If a site offers no vtt at all we
    // end up with a file we do not read, which degrades to "no transcript —
    // press Transcribe" rather than to a wrong one.
    args.push(
      '--write-sub',
      '--write-auto-sub',
      '--sub-lang',
      request.language,
      '--sub-format',
      'vtt',
    )
  }

  if (request.proxyUrl) args.push('--proxy', request.proxyUrl)
  // Only consulted when streams must be merged. Passing it unconditionally keeps
  // the download off PATH — the vendored ffmpeg in tools/ is the one the rest of
  // the app uses, and having two different ffmpegs is a bug waiting to happen.
  if (request.ffmpegLocation) args.push('--ffmpeg-location', request.ffmpegLocation)

  args.push(request.url)
  return args
}

/** The output template. The id, not the title: a filename we can predict. */
export function outputTemplate(destDir: string, kind: DownloaderKind): string {
  // `%(id)s.%(ext)s` outside a playlist is unique per video, so the resulting
  // path is known before the download starts. The human title travels separately,
  // through `ingestFile({ title })`, which is where it belongs.
  void kind
  return path.join(destDir, '%(id)s.%(ext)s')
}

// --- output parsing ----------------------------------------------------------

export type DownloadProgress = {
  percent: number
  /** e.g. `302.04KiB` — the site's own unit, not ours. */
  total: string | null
  speed: string | null
  eta: string | null
  /** True for the terminal `100% … in 00:01` line, where the trailing time is
   *  how long it took rather than how long is left. */
  complete: boolean
}

/**
 * youtube-dl's `--newline` progress line. Measured against a real run:
 *
 *   [download]   0.3% of ~302.04KiB at  5.38KiB/s ETA 00:55
 *   [download] 100% of 302.04KiB in 00:01
 *
 * Both shapes must parse or the bar sticks at 99%. The trailing keyword is
 * captured rather than assumed, because on the final line `in 00:01` is the
 * *elapsed* time — reporting it as an ETA would leave a finished download
 * claiming one second remaining.
 */
const PROGRESS_RE =
  /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s|Unknown\s+B\/s))?(?:\s+(ETA|in)\s+([\d:]+|Unknown))?/

export function parseDownloadProgress(line: string): DownloadProgress | null {
  const match = PROGRESS_RE.exec(line.trim())
  if (!match) return null
  const percent = Number(match[1])
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null

  const keyword = match[4]
  const speed = match[3] && !/Unknown/.test(match[3]) ? match[3].replace(/\s+/g, '') : null
  const time = match[5]

  return {
    percent,
    total: match[2]?.replace(/\s+/g, '') ?? null,
    speed,
    // `ETA Unknown` is literal text on the first lines of a transfer; passing it
    // through would show the user "ETA Unknown" instead of nothing.
    eta: keyword === 'ETA' && time && time !== 'Unknown' ? time : null,
    complete: keyword === 'in',
  }
}

/** `[download] Destination: D:\...\abc123.m4a` — the one line that names the file. */
export function parseDestination(line: string): string | null {
  const match = /^\[download\]\s+Destination:\s+(.+)$/.exec(line.trim())
  return match ? match[1].trim() : null
}

export type VideoMetadata = {
  id: string
  title: string
  durationMs: number | null
  uploader: string | null
  webpageUrl: string | null
  /** True when the site offers a caption track (manual or automatic). */
  hasCaptions: boolean
  /** e.g. `youtube`, `vimeo` — the extractor that handled this URL. */
  extractor: string | null
}

/**
 * Read `--dump-json`.
 *
 * The output is not guaranteed to be a single line — youtube-dl pretty-prints
 * in some builds and prints one object per line for a playlist — so this slices
 * from the first `{` to the last `}` rather than looking for a lone line of JSON.
 * For a playlist dump that yields only the last object, which is a deliberate
 * trade: `--no-playlist` means there should only ever be one, and returning the
 * *last* one keeps a partially-written tail from being mistaken for the answer.
 */
export function parseMetadata(stdout: string): VideoMetadata | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    const raw = JSON.parse(stdout.slice(start, end + 1)) as {
      id?: string
      title?: string
      duration?: number
      uploader?: string
      webpage_url?: string
      extractor?: string
      subtitles?: Record<string, unknown>
      automatic_captions?: Record<string, unknown>
    }
    if (!raw.id) return null
    const captionLangs = [
      ...Object.keys(raw.subtitles ?? {}),
      ...Object.keys(raw.automatic_captions ?? {}),
    ]
    return {
      id: raw.id,
      title: raw.title?.trim() || raw.id,
      durationMs: typeof raw.duration === 'number' ? Math.round(raw.duration * 1000) : null,
      uploader: raw.uploader ?? null,
      webpageUrl: raw.webpage_url ?? null,
      hasCaptions: captionLangs.length > 0,
      extractor: raw.extractor ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Turn youtube-dl's stderr into something worth showing.
 *
 * The raw output is a Python traceback for anything unexpected, and "Download
 * failed: Traceback (most recent call last)" is worse than useless. These are
 * the failures that actually happen, each with the cause a user can act on.
 */
export function explainDownloadFailure(stderr: string): string {
  const text = stderr.replace(/\u001b\[[0-9;]*m/g, '')

  if (/Tunnel connection failed|ProxyError|Cannot connect to proxy/i.test(text)) {
    const host = /(?:Tunnel connection failed|proxy)[^\n]*?(\d{1,3}(?:\.\d{1,3}){3}:\d+)/i.exec(text)?.[1]
    return (
      `The proxy${host ? ` at ${host}` : ''} refused the connection. ` +
      'Start it, or set downloader.proxy in ingest.config.json (use "none" for a direct connection).'
    )
  }
  if (/No video formats found/i.test(text)) {
    return (
      'The site returned a page but no playable stream. This is what a stale extractor looks like — ' +
      'the downloader needs updating (npm run downloader:install -- --update).'
    )
  }
  if (/Unsupported URL|no suitable InfoExtractor/i.test(text)) {
    return 'This URL is not supported by the downloader. Only the sites it knows about work.'
  }
  if (/Video unavailable|Private video|removed by the uploader|This video is not available/i.test(text)) {
    return 'The site says this video is unavailable (removed, private, or region-locked).'
  }
  if (/Sign in to confirm|age-restricted|login required/i.test(text)) {
    return 'This video needs a signed-in session, which this downloader cannot provide.'
  }
  if (/HTTP Error 4\d\d/i.test(text)) {
    return `The site refused the request: ${/HTTP Error 4\d\d[^\n]*/.exec(text)?.[0] ?? 'HTTP error'}.`
  }
  if (/urlopen error|timed out|Temporary failure in name resolution|getaddrinfo/i.test(text)) {
    return (
      'Could not reach the site. Check the network, or the proxy in ingest.config.json ' +
      '(downloader.proxy).'
    )
  }

  // Fall back to the last meaningful stderr lines rather than a traceback.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\s*(File "|Traceback|\w+Error:|raise )/.test(line))
  return lines.slice(-2).join(' ') || 'The downloader failed without saying why.'
}
