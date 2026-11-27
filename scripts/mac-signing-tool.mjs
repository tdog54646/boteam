import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const version = '0.29.0'
// Archive hashes come from the apple-codesign release. Pin the extracted binary
// too, so every build can validate a cached copy without downloading the archive.
const releases = {
  arm64: {
    target: 'aarch64-apple-darwin',
    archive: 'd1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a',
    binary: '6c4623db45f1d89af439a2ce42fd65798ef56aaaa3e4ced48879be05f750aacb',
  },
  x64: {
    target: 'x86_64-apple-darwin',
    archive: '14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140',
    binary: '21588902f0698182c21b14d9623c424eb32595f675ace5b31dc1c3f3b0223ec1',
  },
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function localSigningTool() {
  const release = releases[process.arch]
  if (process.platform !== 'darwin' || !release) {
    throw new Error(`Local macOS signing is unavailable on ${process.platform}-${process.arch}`)
  }
  const name = `apple-codesign-${version}-${release.target}`
  const cache = join(homedir(), 'Library', 'Caches', 'BoTeam Build', name)
  const binary = join(cache, 'rcodesign')
  try {
    if (await sha256(binary) === release.binary) {
      await chmod(binary, 0o700)
      return binary
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  await mkdir(cache, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(cache, '.download-'))
  try {
    const archive = join(staging, `${name}.tar.gz`)
    const url = `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${version}/${name}.tar.gz`
    await run('/usr/bin/curl', ['-q', '--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--max-time', '90',
      '--output', archive, url])
    if (await sha256(archive) !== release.archive) throw new Error(`Invalid SHA-256 for ${name}.tar.gz`)
    await run('/usr/bin/tar', ['-xzf', archive, '-C', staging, '--strip-components', '1', `${name}/rcodesign`])
    const extracted = join(staging, 'rcodesign')
    if (await sha256(extracted) !== release.binary) throw new Error(`Invalid SHA-256 for ${name}/rcodesign`)
    await chmod(extracted, 0o700)
    // Simultaneous builds may publish the same verified executable.
    await rename(extracted, binary)
    return binary
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
