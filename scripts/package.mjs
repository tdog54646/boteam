import { execFileSync } from 'node:child_process'
import { packager } from '@electron/packager'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pty = '/node_modules/node-pty'
const runtimeDirs = [pty + '/lib', pty + '/build/Release', pty + '/prebuilds/' + process.platform + '-' + process.arch]
function ignore(file) {
  if (!file || /^\/(desktop|dist)(\/|$)|^\/package\.json$/.test(file)) return false
  if ([pty + '/LICENSE', pty + '/package.json'].includes(file)) return false
  if (/\.(?:pdb|map)$|\.test\.js$/.test(file)) return true
  return !runtimeDirs.some(dir => dir === file || dir.startsWith(file + '/') || file.startsWith(dir + '/'))
}
const result = await packager({
  dir: root,
  out: process.argv[2] || join(root, 'release'),
  name: 'BoTeam',
  appBundleId: 'local.boteam.desktop',
  protocols: [{ name: 'BoTeam 聊天', schemes: ['boteam'] }],
  icon: join(root, 'assets/BoTeam.icns'),
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: { unpackDir: 'node_modules/node-pty' },
  prune: false,
  ignore,
})
if (process.platform === 'darwin') {
  for (const folder of result) {
    const bundle = join(folder, 'BoTeam.app')
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
      stdio: 'inherit',
    })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle], {
      stdio: 'inherit',
    })
  }
}
console.log(result.join('\n'))
