/**
 * Stages a video downloader into ./tools/downloader.
 *
 * ## Why this exists
 *
 * The obvious install is `pip install youtube-dl`. It is also the one that does
 * not apply here: what this machine actually has is a *source checkout* that the
 * interpreter finds through sys.path — a directory under a scratch workspace
 * that will be deleted the moment that workspace is. A downloader that only
 * works until someone cleans a temp folder is not a dependency, it is a
 * time bomb.
 *
 * So this script copies the `youtube_dl` / `yt_dlp` package into `tools/`, which
 * is already gitignored and already the place reproduce-with-one-command things
 * live. `lib/server/download-tools.ts` then runs it as `python -m <package>`
 * with the working directory set to the copy, which is all that is needed for it
 * to resolve — no install, no PYTHONPATH, no admin rights.
 *
 * ## Where the copy comes from, in order
 *
 *   1. `--from <dir>`              an existing checkout you name
 *   2. the interpreter already has it   asked via `import`, so it works even
 *                                       when the checkout is registered only
 *                                       through sys.path and cannot be found by
 *                                       searching the filesystem
 *   3. `git clone` through the GitHub proxy   github.com itself times out here
 *
 * Usage:
 *   npm run downloader:install
 *   npm run downloader:install -- --from "D:\path\to\youtube-dl"
 *   npm run downloader:install -- --kind yt-dlp
 *   npm run downloader:install -- --list
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const downloaderRoot = path.join(projectRoot, 'tools', 'downloader')

/** `youtube-dl` is the original and is still maintained on master; `yt-dlp` is
 *  the fork with the more aggressive release cadence. Both speak the same CLI
 *  for everything this app does, so either works and the choice is a preference. */
const KINDS = {
  'youtube-dl': {
    module: 'youtube_dl',
    repo: 'https://github.com/ytdl-org/youtube-dl.git',
    minFiles: 100,
  },
  'yt-dlp': {
    module: 'yt_dlp',
    repo: 'https://github.com/yt-dlp/yt-dlp.git',
    minFiles: 100,
  },
}

/**
 * Read through the GitHub proxy that the rest of this project already uses.
 * Measured working for both `ls-remote` and `clone` — `github.com` itself times
 * out on this network.
 */
const GIT_PROXY = 'https://ghfast.top/'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : null
}
const force = argv.includes('--force')
const kindArg = flag('--kind')
const fromArg = flag('--from')

/**
 * Interpreters to try, in order. `--python` wins, then `EL_PYTHON`, then a bare
 * name, then the conventional install locations.
 *
 * The bare names are first because they are what a normal shell has. The
 * absolute paths are the safety net for the case this project actually hit:
 * a shell with a near-empty PATH, where `python` is simply not a command and a
 * perfectly good interpreter sits in `C:\Program Files\Python314`. Every
 * candidate is verified by running it, so a stale entry costs one failed spawn.
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
function expandRoot(pattern) {
  const segments = pattern.split('/')
  const last = segments.pop()
  if (!last || !last.includes('*')) return []
  const parent = segments.join('/') || '/'
  let entries
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

function pythonCandidates() {
  const list = []
  if (flag('--python')) list.push(flag('--python'))
  if (process.env.EL_PYTHON) list.push(process.env.EL_PYTHON)
  list.push('python', 'python3', 'py')
  for (const root of DISCOVERY_ROOTS) {
    for (const dir of expandRoot(root)) {
      list.push(path.join(dir, 'python.exe'), path.join(dir, 'python3'), path.join(dir, 'python'))
    }
  }
  return [...new Set(list)]
}

/**
 * Run a command and collect its output.
 *
 * Async `spawn`, never `spawnSync`. Measured here: every `spawnSync` call fails
 * with `EBUSY` — with or without `windowsHide`, with or without `shell`, bare
 * name or absolute path — while async `spawn` runs the identical command and
 * returns 0. Because the failure lands in `result.error` rather than being
 * thrown, a `spawnSync`-based probe reads a working tool as "not installed",
 * which is precisely the wrong diagnosis.
 */
function runCapture(command, args, { cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => child.kill(), timeoutMs)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (error) =>
      finish({ ok: false, code: null, stdout, stderr, error: error.code ?? error.message }),
    )
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr, error: null }))
  })
}

/** Ask one interpreter where a package lives. Returns null when it has none. */
async function locateViaPython(moduleName) {
  const script = [
    'import json, os, sys',
    'try:',
    `    import ${moduleName} as m`,
    'except Exception:',
    '    print("null"); sys.exit(0)',
    'p = os.path.dirname(os.path.abspath(m.__file__))',
    'print(json.dumps({"package": p, "version": getattr(m, "version", None) and getattr(m.version, "__version__", None)}))',
  ].join('\n')

  for (const python of pythonCandidates()) {
    const result = await runCapture(python, ['-c', script])
    if (!result.ok) continue
    const line = result.stdout.trim().split(/\r?\n/).pop()
    if (!line || line === 'null') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed.package) return { python, ...parsed }
    } catch {
      continue
    }
  }
  return null
}

function copyDir(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, {
    recursive: true,
    // `__pycache__` holds bytecode compiled by a different interpreter version
    // and would be silently preferred over the source on some builds.
    filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
  })
}

async function cloneInto(repo, destination) {
  const git = await findGit()
  if (!git) return { ok: false, reason: 'git was not found' }

  const dir = path.dirname(destination)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  for (const url of [`${GIT_PROXY}${repo}`, repo]) {
    console.log(`    trying ${url}`)
    const result = await runCapture(git, ['clone', '--depth', '1', '--quiet', url, path.join(dir, 'repo')], {
      timeoutMs: 600_000,
    })
    if (result.ok) return { ok: true, url }
    const detail = result.error ?? result.stderr.trim().split('\n').pop() ?? `exit ${result.code}`
    console.log(`      failed: ${detail}`)
  }
  return { ok: false, reason: 'every remote failed' }
}

/**
 * Git is not necessarily on PATH here — this shell has a near-empty PATH and
 * the portable install lives in a versioned directory. Checking the usual spots
 * beats assuming, and the async probe is what makes the check meaningful at all
 * (see `runCapture` above).
 */
async function findGit() {
  if ((await runCapture('git', ['--version'])).ok) return 'git'

  const candidates = [
    'D:/MyConfiguration/TCLXUSER/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ].filter((candidate) => fs.existsSync(candidate))

  for (const candidate of candidates) {
    if ((await runCapture(candidate, ['--version'])).ok) return candidate
  }
  return null
}

function countPackageFiles(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).filter((entry) => String(entry).endsWith('.py'))
      .length
  } catch {
    return 0
  }
}

async function install(kind, { force, fromArg }) {
  const spec = KINDS[kind]
  const destination = path.join(downloaderRoot, kind, spec.module)
  const existing = countPackageFiles(destination)

  if (existing > 0 && !force) {
    console.log(`  ${kind}: already staged (${existing} files) — pass --force to replace`)
    return true
  }

  console.log(`  ${kind}: → ${destination}`)

  // 1. a checkout the user named
  if (fromArg) {
    const source = path.join(path.resolve(fromArg), spec.module)
    if (fs.existsSync(source)) {
      copyDir(source, destination)
      console.log(`    copied from ${source}`)
      return report(destination, spec)
    }
    console.log(`    --from ${fromArg} has no ${spec.module}/ inside it; falling back`)
  }

  // 2. whatever the interpreter already imports — works for a checkout that is
  //    only on sys.path, which no filesystem search would ever find.
  const located = await locateViaPython(spec.module)
  if (located) {
    copyDir(located.package, destination)
    console.log(
      `    copied from ${located.package}` +
        `${located.version ? ` (${spec.module} ${located.version})` : ''} via ${located.python}`,
    )
    return report(destination, spec)
  }
  console.log(`    no interpreter here can import ${spec.module}`)

  // 3. clone it
  console.log(`    cloning ${spec.repo}`)
  const cloned = await cloneInto(spec.repo, destination)
  if (!cloned.ok) {
    console.log(`    ${cloned.reason}`)
    return false
  }
  const staged = path.join(path.dirname(destination), 'repo', spec.module)
  if (!fs.existsSync(staged)) {
    console.log(`    the clone did not contain ${spec.module}/`)
    return false
  }
  copyDir(staged, destination)
  fs.rmSync(path.join(path.dirname(destination), 'repo'), { recursive: true, force: true })
  console.log(`    cloned via ${cloned.url}`)
  return report(destination, spec)
}

function report(destination, spec) {
  const files = countPackageFiles(destination)
  if (files < spec.minFiles / 10) {
    console.log(`    only ${files} .py files — that looks incomplete`)
    return false
  }
  console.log(`    ok — ${files} .py files`)
  return true
}

async function main() {
  if (argv.includes('--list')) {
    console.log('Downloader packages and whether one is bundled:')
    for (const [kind, spec] of Object.entries(KINDS)) {
      const dir = path.join(downloaderRoot, kind, spec.module)
      const staged = countPackageFiles(dir)
      console.log(
        `  ${kind.padEnd(12)} ${staged > 0 ? `staged (${staged} files)` : 'not staged'}  ${dir}`,
      )
    }
    return 0
  }

  if (kindArg && !KINDS[kindArg]) {
    console.error(`Unknown --kind "${kindArg}". Known: ${Object.keys(KINDS).join(', ')}`)
    return 2
  }

  const kinds = kindArg ? [kindArg] : Object.keys(KINDS)

  console.log(`Staging a downloader into ${downloaderRoot}\n`)

  const results = []
  for (const kind of kinds) {
    results.push({ kind, ok: await install(kind, { force, fromArg }) })
  }

  console.log('')
  for (const { kind, ok } of results) {
    console.log(`  ${ok ? 'ok     ' : 'FAILED '} ${kind}`)
  }

  if (results.every((entry) => !entry.ok)) {
    console.log(
      '\nNothing was staged. The app can still download if a copy is importable,\n' +
        'otherwise install one by hand:\n' +
        '  pip install yt-dlp\n' +
        'or point the app straight at a checkout you already have:\n' +
        '  npm run downloader:install -- --from "D:\\path\\to\\youtube-dl"\n',
    )
    return 1
  }

  console.log('\nDone. Check it with:  npm run fetch -- --doctor\n')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
