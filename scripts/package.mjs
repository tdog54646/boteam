import { execFileSync } from 'node:child_process'
import { packager } from '@electron/packager'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const result = await packager({
  dir: root,
  out: process.argv[2] || join(root, 'release'),
  name: 'BoTeam',
  appBundleId: 'local.boteam.desktop',
  icon: join(root, 'assets/BoTeam.icns'),
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: true,
  prune: false,
  ignore: (file) => !!file && !/^\/(desktop|dist)(\/|$)|^\/package\.json$/.test(file),
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
