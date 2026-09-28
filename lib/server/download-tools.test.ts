import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDownloadArgs,
  buildMetadataArgs,
  DEFAULT_PROBE_TARGET,
  expandRoot,
  explainDownloadFailure,
  formatSelector,
  isPortOpen,
  parseDownloadProgress,
  parseDestination,
  parseMetadata,
  parseProxyUrl,
  probeTargetFor,
  proxyFromEnv,
  pythonCandidates,
  resolveDownloadProxy,
  resolveDownloader,
  runCapture,
  WELL_KNOWN_PROXY_PORTS,
} from './download-tools'
import { loadConfig, type LoadedConfig } from './config'

/**
 * These tests exist because every one of these functions is a place where a
 * plausible-looking implementation is wrong, and wrong *quietly*:
 *
 *   - the progress regex is measured against real youtube-dl output, whose last
 *     line has no speed and no ETA — a regex that only matches the middle shape
 *     leaves the bar stuck at 99% forever
 *   - `--dump-json` is not line-delimited in every build
 *   - `getproxies()` on Windows returns a *dead* registry proxy regardless of
 *     `HTTP_PROXY`, which is the failure this whole module exists to prevent
 */

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-dl-'))
  tempDirs.push(dir)
  return dir
}

function configWith(overrides: Partial<LoadedConfig['downloader']>): LoadedConfig {
  const base = loadConfig()
  return {
    ...base,
    toolsDir: tempDir(),
    downloader: { ...base.downloader, ...overrides },
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseDownloadProgress', () => {
  it('reads a mid-transfer line', () => {
    // Copied verbatim from a real run.
    const result = parseDownloadProgress('[download]   0.3% of ~302.04KiB at  5.38KiB/s ETA 00:55')
    expect(result).toEqual({
      percent: 0.3,
      total: '302.04KiB',
      speed: '5.38KiB/s',
      eta: '00:55',
      complete: false,
    })
  })

  it('reads the final line, whose trailing time is elapsed and not an ETA', () => {
    // This is the shape a naive regex misses, and missing it is why a progress
    // bar sits at 99% after the file is already on disk. Reporting `00:01` as an
    // ETA would be worse: a finished download claiming a second remaining.
    const result = parseDownloadProgress('[download] 100% of 302.04KiB in 00:01')
    expect(result).toEqual({
      percent: 100,
      total: '302.04KiB',
      speed: null,
      eta: null,
      complete: true,
    })
  })

  it('treats an unknown speed and ETA as unknown rather than as text', () => {
    const result = parseDownloadProgress(
      '[download]   0.0% of 3.41MiB at Unknown B/s ETA Unknown',
    )
    expect(result?.speed).toBeNull()
    expect(result?.eta).toBeNull()
    expect(result?.total).toBe('3.41MiB')
  })

  it('ignores other lines, including the destination line', () => {
    expect(parseDownloadProgress('[download] Destination: D:\\media\\abc.m4a')).toBeNull()
    expect(parseDownloadProgress('[youtube] abc: Downloading webpage')).toBeNull()
    expect(parseDownloadProgress('')).toBeNull()
  })

  it('rejects impossible percentages instead of reporting them', () => {
    expect(parseDownloadProgress('[download] 150% of 1KiB at 1KiB/s ETA 00:01')).toBeNull()
  })
})

describe('parseDestination', () => {
  it('pulls the path out of the one line that names the file', () => {
    expect(parseDestination('[download] Destination: D:\\media\\abc123.m4a')).toBe(
      'D:\\media\\abc123.m4a',
    )
  })

  it('returns null for any other line', () => {
    expect(parseDestination('[download] 100% of 1KiB in 00:01')).toBeNull()
  })
})

describe('parseMetadata', () => {
  const base = { id: 'abc', title: 'A Talk', duration: 3725.4 }

  it('reads the fields the library entry needs', () => {
    const result = parseMetadata(JSON.stringify(base))
    expect(result).toEqual({
      id: 'abc',
      title: 'A Talk',
      durationMs: 3725400,
      uploader: null,
      webpageUrl: null,
      hasCaptions: false,
      extractor: null,
    })
  })

  it('survives pretty-printed JSON spanning many lines', () => {
    // Not every build prints one compact object, so the parser must not assume
    // that a line beginning with `{` is itself a complete object.
    const pretty = JSON.stringify({ ...base, subtitles: { en: [] } }, null, 2)
    expect(parseMetadata(pretty)?.hasCaptions).toBe(true)
  })

  it('counts automatic captions as captions', () => {
    const withAuto = JSON.stringify({ ...base, automatic_captions: { en: [] } })
    expect(parseMetadata(withAuto)?.hasCaptions).toBe(true)
  })

  it('falls back to the id when there is no title', () => {
    expect(parseMetadata(JSON.stringify({ id: 'abc' }))?.title).toBe('abc')
  })

  it('returns null for output that is not a video object', () => {
    expect(parseMetadata('')).toBeNull()
    expect(parseMetadata('ERROR: something went wrong')).toBeNull()
    expect(parseMetadata('{"title":"no id here"}')).toBeNull()
  })
})

describe('formatSelector', () => {
  it('prefers m4a for audio, because the fallback chain is what makes it work', () => {
    // Measured: `bestaudio` alone returns webm/opus on YouTube; m4a is smaller
    // to decode and universally playable, so it is asked for first.
    expect(formatSelector({ mode: 'audio', maxHeight: 720 })).toBe(
      'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    )
  })

  it('caps video height and always keeps a last-resort branch', () => {
    const selector = formatSelector({ mode: 'video', maxHeight: 720 })
    expect(selector).toContain('height<=720')
    expect(selector.endsWith('/best')).toBe(true)
  })

  it('clamps an absurd height rather than passing it through', () => {
    expect(formatSelector({ mode: 'video', maxHeight: 0 })).toContain('height<=144')
  })
})

describe('buildDownloadArgs', () => {
  const base = {
    url: 'https://example.com/watch?v=abc',
    outputTemplate: 'D:\\media\\%(id)s.%(ext)s',
    proxyUrl: null,
    media: { mode: 'audio' as const, maxHeight: 720 },
    captions: true,
    language: 'en',
    ffmpegLocation: null,
  }

  it('passes --proxy whenever a proxy was resolved', () => {
    // The single most important flag here: without it, youtube-dl consults
    // urllib's getproxies(), which on Windows returns the registry's entry —
    // frequently a dead port — and every download becomes a 502.
    const args = buildDownloadArgs({ ...base, proxyUrl: 'http://127.0.0.1:7897' })
    expect(args).toContain('--proxy')
    expect(args[args.indexOf('--proxy') + 1]).toBe('http://127.0.0.1:7897')
  })

  it('omits --proxy when there is none, so a direct connection is not forced through a dead port', () => {
    expect(buildDownloadArgs(base)).not.toContain('--proxy')
  })

  it('asks for vtt captions, and only for flags youtube-dl actually accepts', () => {
    const args = buildDownloadArgs(base)
    expect(args).toContain('--write-auto-sub')
    expect(args).toContain('--sub-format')
    expect(args[args.indexOf('--sub-format') + 1]).toBe('vtt')
    // Verified against `youtube-dl --help` (2025.04.07). Both of these are
    // yt-dlp-only and make youtube-dl abort with "no such option" / "ambiguous
    // option" — a hard failure, not a degraded download.
    expect(args).not.toContain('--no-convert-subs')
    expect(args).not.toContain('--print')
  })

  it('leaves subtitles alone when they were not asked for', () => {
    const args = buildDownloadArgs({ ...base, captions: false })
    expect(args).not.toContain('--write-auto-sub')
    expect(args).not.toContain('--sub-lang')
  })

  it('only passes --ffmpeg-location when one is known', () => {
    expect(buildDownloadArgs(base)).not.toContain('--ffmpeg-location')
    const withFfmpeg = buildDownloadArgs({ ...base, ffmpegLocation: 'D:\\tools\\ffmpeg.exe' })
    expect(withFfmpeg[withFfmpeg.indexOf('--ffmpeg-location') + 1]).toBe('D:\\tools\\ffmpeg.exe')
  })

  it('asks for one video at a time and for newline progress', () => {
    const args = buildDownloadArgs(base)
    // Without --newline, progress arrives as \r-overwritten frames and the
    // line-based reader would see a single enormous line and report nothing.
    expect(args).toContain('--newline')
    // A playlist URL would otherwise silently pull dozens of files into data/media.
    expect(args).toContain('--no-playlist')
  })

  it('only asks for a merge when there is something to merge', () => {
    expect(buildDownloadArgs(base)).not.toContain('--merge-output-format')
    expect(buildDownloadArgs({ ...base, media: { mode: 'video', maxHeight: 720 } })).toContain(
      '--merge-output-format',
    )
  })

  it('puts the URL last, where the parser expects it', () => {
    expect(buildDownloadArgs(base).at(-1)).toBe(base.url)
  })
})

describe('buildMetadataArgs', () => {
  it('simulates rather than downloading, and dumps JSON', () => {
    const args = buildMetadataArgs({ url: 'https://x/y', proxyUrl: null })
    expect(args).toContain('--simulate')
    expect(args).toContain('--dump-json')
    // --print does not exist in youtube-dl; passing it aborts with
    // "ambiguous option: --print (--print-json, --print-traffic?)".
    expect(args).not.toContain('--print')
    expect(args.at(-1)).toBe('https://x/y')
  })
})

describe('parseProxyUrl', () => {
  it('accepts a bare host:port, which is how the registry stores it', () => {
    expect(parseProxyUrl('127.0.0.1:7897')).toEqual({ host: '127.0.0.1', port: 7897 })
  })

  it('accepts a full URL', () => {
    expect(parseProxyUrl('http://127.0.0.1:7897')).toEqual({ host: '127.0.0.1', port: 7897 })
  })

  it('rejects what cannot be a proxy', () => {
    expect(parseProxyUrl('')).toBeNull()
    expect(parseProxyUrl('http://:0')).toBeNull()
  })
})

describe('proxyFromEnv', () => {
  it('honours an explicit override first', () => {
    expect(
      proxyFromEnv({ EL_DOWNLOAD_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }),
    ).toBe('http://a:1')
  })

  it('prefers lowercase, which is the spelling urllib actually trusts', () => {
    // Measured on the target machine: with only HTTPS_PROXY set, urllib's
    // getproxies() still returned the Windows registry value. Lowercase is the
    // one that reliably wins.
    expect(proxyFromEnv({ https_proxy: 'http://low:1', HTTPS_PROXY: 'http://up:2' })).toBe(
      'http://low:1',
    )
  })

  it('returns null when there is nothing to go on', () => {
    expect(proxyFromEnv({})).toBeNull()
  })
})

describe('resolveDownloadProxy', () => {
  /** Every check answers "can this proxy tunnel to the target?", so a test does no real I/O. */
  const only = (port: number) => async (proxy: { host: string; port: number }) => ({
    ok: proxy.port === port,
    reason: 'test',
  })

  it('uses the configured proxy when it answers', async () => {
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'http://127.0.0.1:7897' }),
      env: {},
      registry: async () => null,
      check: only(7897),
    })
    expect(result.url).toBe('http://127.0.0.1:7897')
    expect(result.source).toBe('config')
    expect(result.warning).toBeNull()
  })

  it('reports a configured proxy that cannot be used instead of using it', async () => {
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'http://127.0.0.1:52389' }),
      env: {},
      registry: async () => null,
      check: async () => ({ ok: false, reason: 'the proxy answered 502 Bad Gateway' }),
    })
    expect(result.url).toBeNull()
    // The whole point of the check: this is the exact situation that produced
    // "Tunnel connection failed: 502 Bad Gateway" with no hint that a proxy was
    // involved at all.
    expect(result.warning).toContain('127.0.0.1:52389')
    expect(result.warning).toContain('502')
    expect(result.warning).toContain('downloader.proxy')
  })

  it('falls through a rejected proxy to one that can reach the target', async () => {
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'auto' }),
      env: {},
      registry: async () => '127.0.0.1:52389',
      check: only(7897),
    })
    expect(result.url).toBe('http://127.0.0.1:7897')
    expect(result.source).toBe('probe')
    // Both facts matter: which proxy is in use, and which one was ignored.
    expect(result.warning).toContain('52389')
  })

  it('health-checks a proxy even when it was named explicitly', async () => {
    // An explicitly configured proxy is still verified. Naming one is a
    // statement of intent, not a guarantee that it is up.
    let checked = false
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'http://127.0.0.1:7897' }),
      env: {},
      registry: async () => null,
      check: async () => {
        checked = true
        return { ok: true, reason: 'ok' }
      },
    })
    expect(checked).toBe(true)
    expect(result.url).toBe('http://127.0.0.1:7897')
  })

  it('honours an explicit "none" without probing anything', async () => {
    let probed = false
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'none' }),
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
      registry: async () => '127.0.0.1:52389',
      check: async () => {
        probed = true
        return { ok: true, reason: 'ok' }
      },
    })
    expect(result.url).toBeNull()
    expect(result.source).toBe('none')
    expect(probed).toBe(false)
  })

  it('says so when nothing anywhere is usable', async () => {
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'auto' }),
      env: {},
      registry: async () => '127.0.0.1:52389',
      check: async () => ({ ok: false, reason: 'nothing listening' }),
    })
    expect(result.url).toBeNull()
    expect(result.warning).toContain('directly')
  })

  it('tries the well-known local ports when nothing is configured', async () => {
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'auto' }),
      env: {},
      registry: async () => null,
      check: only(WELL_KNOWN_PROXY_PORTS[1]),
    })
    expect(result.source).toBe('probe')
    expect(result.url).toBe(`http://127.0.0.1:${WELL_KNOWN_PROXY_PORTS[1]}`)
  })

  it('prefers a proxy the environment names over the well-known ports', async () => {
    // Env first, ports last: something that set a proxy variable meant it.
    const result = await resolveDownloadProxy({
      config: configWith({ proxy: 'auto' }),
      env: { https_proxy: 'http://127.0.0.1:8123' },
      registry: async () => null,
      check: only(8123),
    })
    expect(result.source).toBe('env')
    expect(result.url).toBe('http://127.0.0.1:8123')
  })

  it('checks reachability of the site, not just of the proxy', async () => {
    // A proxy can be perfectly healthy and still refuse the host we need. The
    // target is passed through so that case is detected rather than diagnosed.
    const seen: { host: string; port: number }[] = []
    await resolveDownloadProxy({
      config: configWith({ proxy: 'http://127.0.0.1:7897' }),
      env: {},
      registry: async () => null,
      target: { host: 'vimeo.com', port: 443 },
      check: async (proxy) => {
        seen.push(proxy)
        return { ok: false, reason: 'refused' }
      },
    })
    expect(seen).toEqual([{ host: '127.0.0.1', port: 7897 }])
  })
})

describe('probeTargetFor', () => {
  it('takes the host from the URL, which is what will actually be fetched', () => {
    expect(probeTargetFor('https://www.youtube.com/watch?v=abc')).toEqual({
      host: 'www.youtube.com',
      port: 443,
    })
    expect(probeTargetFor('https://vimeo.com:8443/1')).toEqual({ host: 'vimeo.com', port: 8443 })
  })

  it('falls back to a known target for anything unusable', () => {
    expect(probeTargetFor('not a url')).toEqual(DEFAULT_PROBE_TARGET)
  })
})

describe('isPortOpen', () => {
  it('is false for a port nothing listens on', async () => {
    // 1 is reserved and never has a listener in practice.
    await expect(isPortOpen('127.0.0.1', 1, 300)).resolves.toBe(false)
  })
})

describe('resolveDownloader', () => {
  it('refuses clearly when there is no interpreter at all', async () => {
    const result = await resolveDownloader({
      config: configWith({ pythonPath: null }),
      pythons: ['definitely-not-a-python'],
      probe: async () => null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.kind).toBe('missing-python')
  })

  it('says the downloader is missing when python works but has no package', async () => {
    const result = await resolveDownloader({
      config: configWith({}),
      pythons: ['python'],
      probe: async () => ({ exe: 'python', version: '3.13.0', modules: { 'youtube-dl': false, 'yt-dlp': false } }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.kind).toBe('missing-downloader')
    expect(result.problem.remedy).toContain('downloader:install')
  })

  it('prefers a bundled copy over an installed package', async () => {
    // A bundled copy is what makes a fresh clone behave identically and what
    // survives the source checkout being deleted.
    const config = configWith({})
    const dir = path.join(config.toolsDir, 'downloader', 'youtube-dl')
    fs.mkdirSync(path.join(dir, 'youtube_dl'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'youtube_dl', '__init__.py'), '')

    const result = await resolveDownloader({
      config,
      pythons: ['python'],
      probe: async () => ({
        exe: 'C:\\Python313\\python.exe',
        version: '3.13.0',
        modules: { 'youtube-dl': true, 'yt-dlp': true },
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.downloader.origin).toContain('tools/downloader')
    // The cwd is what makes `python -m youtube_dl` resolve to the bundled copy.
    expect(result.downloader.cwd).toBe(dir)
    expect(result.downloader.prefix).toEqual(['-m', 'youtube_dl'])
  })

  it('falls back to an importable package when nothing is bundled', async () => {
    const result = await resolveDownloader({
      config: configWith({}),
      pythons: ['python'],
      probe: async () => ({
        exe: 'C:\\Python313\\python.exe',
        version: '3.13.0',
        modules: { 'youtube-dl': true, 'yt-dlp': false },
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.downloader.cwd).toBeNull()
    expect(result.downloader.origin).toContain('importable')
  })

  it('prefers yt-dlp when both are importable, because it is the maintained one', async () => {
    const result = await resolveDownloader({
      config: configWith({}),
      pythons: ['python'],
      probe: async () => ({
        exe: 'C:\\Python313\\python.exe',
        version: '3.13.0',
        modules: { 'youtube-dl': true, 'yt-dlp': true },
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.downloader.kind).toBe('yt-dlp')
  })
})

describe('runCapture', () => {
  it('runs a process and collects its output', async () => {
    // This is a regression test for a measured environment quirk, not a
    // hypothetical: every `spawnSync` call in this project's shell fails with
    // EBUSY, in all four variants tried, while async `spawn` runs the identical
    // command and returns 0. A `spawnSync`-based probe therefore reads a working
    // tool as "not installed", which is the worst possible diagnosis.
    const result = await runCapture(process.execPath, ['-e', 'process.stdout.write("hello")'])
    expect(result.ok).toBe(true)
    expect(result.spawnError).toBeNull()
    expect(result.stdout).toBe('hello')
  })

  it('reports a missing binary as a spawn error rather than a crash', async () => {
    const result = await runCapture('definitely-not-a-real-binary-xyz', ['--version'])
    expect(result.ok).toBe(false)
    expect(result.spawnError).toBeTruthy()
  })

  it('reports a non-zero exit as a failure', async () => {
    const result = await runCapture(process.execPath, ['-e', 'process.exit(3)'])
    expect(result.ok).toBe(false)
    expect(result.code).toBe(3)
  })
})

describe('expandRoot', () => {
  it('expands a wildcard into the real directories that exist', () => {
    const roots = expandRoot('C:/Program Files/Python3*')
    // Only assert the shape: this machine may legitimately have none.
    for (const root of roots) {
      expect(root.startsWith('C:/Program Files/Python3')).toBe(true)
    }
  })

  it('returns nothing for a path that is not there', () => {
    expect(expandRoot('Z:/definitely/not/here/*')).toEqual([])
  })

  it('ignores a pattern whose wildcard is not in the last segment', () => {
    expect(expandRoot('C:/nope/*/python.exe')).toEqual([])
  })
})

describe('pythonCandidates', () => {
  it('puts an explicitly configured interpreter first', () => {
    const candidates = pythonCandidates(configWith({ pythonPath: 'C:\\Python\\python.exe' }))
    expect(candidates[0]).toBe('C:\\Python\\python.exe')
  })

  it('still offers the bare names, which is what a normal shell has', () => {
    const candidates = pythonCandidates(configWith({}))
    expect(candidates).toContain('python')
    expect(candidates).toContain('python3')
  })

  it('never repeats a candidate', () => {
    const candidates = pythonCandidates(configWith({}))
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('explainDownloadFailure', () => {
  it('turns a tunnel failure into the proxy it actually is', () => {
    // The measured failure on the target machine, verbatim shape.
    const message = explainDownloadFailure(
      'WARNING: [youtube] Unable to download webpage: <urlopen error Tunnel connection failed: 502 Bad Gateway>',
    )
    expect(message).toContain('proxy')
    expect(message).toContain('downloader.proxy')
  })

  it('names a stale extractor for what it is', () => {
    const message = explainDownloadFailure('ERROR: No video formats found; please report this issue')
    expect(message).toContain('updating')
  })

  it('distinguishes an unsupported site from an unavailable video', () => {
    expect(explainDownloadFailure('ERROR: Unsupported URL: https://x/y')).toContain('not supported')
    expect(explainDownloadFailure('ERROR: Video unavailable')).toContain('unavailable')
  })

  it('strips ANSI colour before matching', () => {
    const message = explainDownloadFailure('\u001b[0;31mERROR:\u001b[0m Unsupported URL: https://x/y')
    expect(message).toContain('not supported')
  })

  it('never returns a raw traceback', () => {
    const message = explainDownloadFailure('Traceback (most recent call last):\n  File "x.py"')
    expect(message).not.toContain('Traceback')
    expect(message.length).toBeGreaterThan(0)
  })

  it('always returns something worth showing', () => {
    expect(explainDownloadFailure('')).toBe('The downloader failed without saying why.')
  })
})
