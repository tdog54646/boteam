// The macOS prebuild in node-pty 1.1.0 ships its posix_spawn helper with mode 0644.
import { chmod } from 'node:fs/promises'

if (process.platform === 'darwin') {
  const helper = new URL('../node_modules/node-pty/prebuilds/darwin-' + process.arch + '/spawn-helper', import.meta.url)
  await chmod(helper, 0o755).catch(error => {
    // Source builds place an executable helper under build/Release instead.
    if (error.code !== 'ENOENT') throw error
  })
}
