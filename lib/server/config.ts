import fs from 'node:fs'
import path from 'node:path'

/**
 * Project paths and local configuration.
 *
 * Pure Node module on purpose: the CLI (`bin/ingest.ts`) imports this file, so
 * nothing under lib/server may import `next/*`.
 */

function findProjectRoot(): string {
  const override = process.env.EL_PROJECT_ROOT
  if (override) return path.resolve(override)

  // turbopackIgnore keeps the build tracer from following this walk. The access
  // is dynamic by design (the CLI may be started from any subdirectory) and this
  // app is never deployed as a bundle, so tracing the whole project is pure
  // noise — and it would hide real warnings behind it.
  let candidate = path.resolve(/* turbopackIgnore: true */ process.cwd())
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = path.join(candidate, 'package.json')
    if (fs.existsSync(/* turbopackIgnore: true */ manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }
        if (parsed.name === 'english-listening') return candidate
      } catch {
        // ignore unreadable package.json and keep walking up
      }
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return path.resolve(/* turbopackIgnore: true */ process.cwd())
}

export const PROJECT_ROOT = findProjectRoot()
export const DATA_DIR = path.join(PROJECT_ROOT, 'data')
export const LESSONS_DIR = path.join(DATA_DIR, 'lessons')
export const MANAGED_MEDIA_DIR = path.join(DATA_DIR, 'media')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports')
export const DB_PATH = path.join(DATA_DIR, 'app.db')
export const CONFIG_PATH = path.join(PROJECT_ROOT, 'ingest.config.json')
export const DEFAULT_TOOLS_DIR = path.join(PROJECT_ROOT, 'tools')

export type DownloaderConfig = {
  /**
   * Interpreter to run the downloader with. Null = discover one (`python`,
   * `python3`, `py`, in that order), skipping anything that cannot answer.
   */
  pythonPath: string | null
  /**
   * A source checkout of youtube-dl / yt-dlp. Null = use the bundled copy under
   * `tools/downloader/`, if `npm run downloader:install` has been run.
   */
  directory: string | null
  /**
   * `"auto"` health-checks whatever is configured or detected and uses the first
   * live one; `"none"` forces a direct connection; anything else is used as-is.
   *
   * `"auto"` rather than an explicit URL because the failure it prevents is
   * silent: youtube-dl falls back to the Windows registry proxy, and a stale
   * entry there turns every download into a 502 that names neither the proxy
   * nor the port. See `lib/server/download-tools.ts`.
   */
  proxy: string
  /** Where downloads land. Null = the managed media dir, which the app may clean up. */
  outputDir: string | null
  /** Download the audio stream only. The default, and the point of the feature. */
  audioOnly: boolean
  /** Picture height cap when `audioOnly` is off. */
  maxHeight: number
  /** Also fetch the site's own caption track as a `.vtt` sidecar. */
  captions: boolean
}

export type AppConfig = {
  toolsDir: string
  managedMediaDir: string
  allowedRoots: string[]
  ffprobePath: string | null
  ffmpegPath: string | null
  downloader: DownloaderConfig
}

/** Alias: `loadConfig()` returns the fully-defaulted configuration. */
export type LoadedConfig = AppConfig

const DEFAULT_DOWNLOADER: DownloaderConfig = {
  pythonPath: null,
  directory: null,
  proxy: 'auto',
  outputDir: null,
  audioOnly: true,
  maxHeight: 720,
  captions: true,
}

const DEFAULT_CONFIG: AppConfig = {
  toolsDir: DEFAULT_TOOLS_DIR,
  managedMediaDir: MANAGED_MEDIA_DIR,
  allowedRoots: [],
  ffprobePath: null,
  ffmpegPath: null,
  downloader: DEFAULT_DOWNLOADER,
}

export function loadConfig(): AppConfig {
  let fromDisk: Partial<AppConfig> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<AppConfig> & {
        $comment?: string
      }
      fromDisk = raw
    } catch (error) {
      console.warn(`[config] ingest.config.json is not valid JSON, using defaults: ${String(error)}`)
    }
  }

  const toolsDir = fromDisk.toolsDir
    ? path.resolve(PROJECT_ROOT, fromDisk.toolsDir)
    : DEFAULT_CONFIG.toolsDir
  const managedMediaDir = fromDisk.managedMediaDir
    ? path.resolve(PROJECT_ROOT, fromDisk.managedMediaDir)
    : DEFAULT_CONFIG.managedMediaDir

  const downloader: Partial<DownloaderConfig> = fromDisk.downloader ?? {}

  return {
    toolsDir,
    managedMediaDir,
    allowedRoots: (fromDisk.allowedRoots ?? []).map((root) => path.resolve(root)),
    ffprobePath: fromDisk.ffprobePath ?? null,
    ffmpegPath: fromDisk.ffmpegPath ?? null,
    downloader: {
      // An interpreter and a checkout can legitimately live anywhere, so these
      // are the two config paths that resolve against nothing in particular.
      // Without the ignore hint the build tracer follows them, decides the whole
      // project might be reachable, and buries the real warnings — see the note
      // on `findProjectRoot` above.
      pythonPath: downloader.pythonPath
        ? path.resolve(/* turbopackIgnore: true */ downloader.pythonPath)
        : null,
      directory: downloader.directory
        ? path.resolve(/* turbopackIgnore: true */ downloader.directory)
        : null,
      proxy: downloader.proxy ?? DEFAULT_DOWNLOADER.proxy,
      outputDir: downloader.outputDir
        ? path.resolve(PROJECT_ROOT, downloader.outputDir)
        : DEFAULT_DOWNLOADER.outputDir,
      audioOnly: downloader.audioOnly ?? DEFAULT_DOWNLOADER.audioOnly,
      maxHeight: downloader.maxHeight ?? DEFAULT_DOWNLOADER.maxHeight,
      captions: downloader.captions ?? DEFAULT_DOWNLOADER.captions,
    },
  }
}

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, LESSONS_DIR, MANAGED_MEDIA_DIR, CACHE_DIR, EXPORTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
