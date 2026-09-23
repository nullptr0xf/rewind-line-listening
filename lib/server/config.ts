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

  let candidate = path.resolve(process.cwd())
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = path.join(candidate, 'package.json')
    if (fs.existsSync(manifest)) {
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
  return path.resolve(process.cwd())
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

export type AppConfig = {
  toolsDir: string
  managedMediaDir: string
  allowedRoots: string[]
  ffprobePath: string | null
  ffmpegPath: string | null
}

const DEFAULT_CONFIG: AppConfig = {
  toolsDir: DEFAULT_TOOLS_DIR,
  managedMediaDir: MANAGED_MEDIA_DIR,
  allowedRoots: [],
  ffprobePath: null,
  ffmpegPath: null,
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

  return {
    toolsDir,
    managedMediaDir,
    allowedRoots: (fromDisk.allowedRoots ?? []).map((root) => path.resolve(root)),
    ffprobePath: fromDisk.ffprobePath ?? null,
    ffmpegPath: fromDisk.ffmpegPath ?? null,
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
