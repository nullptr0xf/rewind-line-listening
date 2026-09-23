/**
 * Copies the ffmpeg / ffprobe binaries into ./tools.
 *
 * Why this exists: this machine has no system ffmpeg, and the network here cannot
 * reach the usual download mirrors. Both binaries are available as npm packages
 * that bundle the platform executable, so we take them from the registry and
 * stage them where the app looks for them (see lib/server/probe.ts and
 * ingest.config.json -> toolsDir).
 *
 * tools/ is gitignored: the binaries are large and trivially reproducible with
 * `npm run tools:install`.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = path.join(projectRoot, 'tools')

const TOOLS = [
  { binary: 'ffmpeg', pkg: '@ffmpeg-installer/ffmpeg' },
  { binary: 'ffprobe', pkg: '@ffprobe-installer/ffprobe' },
]

fs.mkdirSync(toolsDir, { recursive: true })

let copied = 0
let failed = 0

for (const { binary, pkg } of TOOLS) {
  let resolved
  try {
    resolved = require(pkg)
  } catch (error) {
    console.error(`${binary}: could not resolve ${pkg} — run npm install first. (${String(error)})`)
    failed += 1
    continue
  }

  const source = resolved.path
  const extension = path.extname(source) || '.exe'
  const destination = path.join(toolsDir, `${binary}${extension}`)

  if (!fs.existsSync(source)) {
    console.error(`${binary}: package resolved to a missing file: ${source}`)
    failed += 1
    continue
  }

  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o755)
  copied += 1
  console.log(`${binary}: ${source} -> ${destination}`)
}

if (copied > 0) {
  console.log(`\nStaged ${copied} binary/binaries in ${toolsDir}`)
}
if (failed > 0) {
  process.exitCode = 1
}
