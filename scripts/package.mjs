import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { packager } from '@electron/packager'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import { bundleId, macSigning, verifyMacSignature } from './mac-signing.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pty = '/node_modules/node-pty'
const runtimeDirs = [pty + '/lib', pty + '/build/Release', pty + '/prebuilds/' + process.platform + '-' + process.arch]
// Use the lockfile's resolved production tree, including nested dependency
// versions. The native PTY still only needs its platform-specific runtime.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const packages = new Set(Object.entries(lock.packages)
  .filter(([path, info]) => path && !info.dev && path !== 'node_modules/node-pty')
  .map(([path]) => '/' + path))
const parents = new Set()
for (const path of packages) {
  for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) parents.add(parent)
}
function ignore(file) {
  if (!file || /^\/(desktop|dist)(\/|$)|^\/package\.json$/.test(file)) return false
  if ([pty + '/LICENSE', pty + '/package.json'].includes(file)) return false
  if (/\.(?:pdb|map)$|\.test\.js$/.test(file)) return true
  if (parents.has(file)) return false
  const modulePath = file.match(/^.*\/node_modules\/(?:@[^/]+\/)?[^/]+/)?.[0]
  if (packages.has(modulePath)) return false
  return !runtimeDirs.some(dir => dir === file || dir.startsWith(file + '/') || file.startsWith(dir + '/'))
}
const out = resolve(process.argv[2] || join(root, 'release'))
const signing = process.platform === 'darwin' ? await macSigning() : null
const options = {
  dir: root,
  name: 'BoTeam',
  appBundleId: bundleId,
  protocols: [{ name: 'BoTeam 聊天', schemes: ['boteam'] }],
  icon: join(root, 'assets/BoTeam.icns'),
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: { unpackDir: 'node_modules/node-pty', unpack: '**/*.node' },
  prune: false,
  ignore,
}
if (signing) {
  // Finish signing and verification before replacing a working installation.
  mkdirSync(out, { recursive: true })
  const staging = mkdtempSync(join(out, '.package-'))
  const previous = join(staging, 'previous')
  try {
    const [folder] = await packager({ ...options, out: staging, osxSign: signing.osxSign })
    const bundle = join(folder, 'BoTeam.app')
    signing.sign?.(bundle)
    verifyMacSignature(bundle, signing.verifyRequirement)
    const target = join(out, basename(folder))
    if (existsSync(target)) renameSync(target, previous)
    try {
      renameSync(folder, target)
    } catch (error) {
      if (existsSync(previous) && !existsSync(target)) renameSync(previous, target)
      throw error
    }
    rmSync(previous, { recursive: true, force: true })
    console.log(target)
  } finally {
    if (!existsSync(previous)) rmSync(staging, { recursive: true, force: true })
  }
} else {
  const result = await packager({ ...options, out })
  console.log(result.join('\n'))
}
