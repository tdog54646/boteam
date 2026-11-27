import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Both releases must contain different signed code. The optional third app is an
// independently signed negative control (for example, an old ad-hoc BoTeam).
const [first, update, other] = process.argv.slice(2)
if (process.platform !== 'darwin' || !first || !update) {
  throw new Error('Usage on macOS: node scripts/verify-mac-keychain.mjs previous.app update.app [other.app]')
}
const executable = app => resolve(app, 'Contents/MacOS/BoTeam')
function codeHash(app) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const match = result.stderr.match(/^CDHash=([a-f0-9]+)$/im)
  assert.ok(match, `Could not read the signed code hash for ${app}`)
  return match[1]
}

assert.notEqual(codeHash(first), codeHash(update), 'Test requires two distinct signed builds')
const temp = mkdtempSync(join(tmpdir(), 'boteam-signing-test-'))
try {
  const addon = join(temp, 'probe.node')
  const source = fileURLToPath(new URL('verify-mac-keychain.c', import.meta.url))
  const includes = resolve(dirname(realpathSync(process.execPath)), '../include/node')
  execFileSync('/usr/bin/xcrun', ['clang', '-bundle', '-undefined', 'dynamic_lookup',
    '-Wno-deprecated-declarations', '-I', includes, source, '-framework', 'Security',
    '-framework', 'CoreFoundation', '-o', addon], { stdio: 'inherit' })

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BOTEAM_PROBE_KEYCHAIN: join(temp, 'private.keychain'),
    BOTEAM_PROBE_PASSWORD: randomBytes(32).toString('hex'),
  }
  function run(exe, operation) {
    const output = execFileSync(exe, ['-p', 'require(process.argv[1])', addon], {
      env: { ...env, BOTEAM_PROBE_OPERATION: operation },
      encoding: 'utf8',
      timeout: 15_000,
    })
    return Number.parseInt(output.trim(), 10)
  }

  assert.equal(run(executable(first), 'create'), 0, 'Create an isolated protected item')
  assert.equal(run(executable(first), 'read'), 0, 'Read the item after restarting')
  assert.equal(run(executable(update), 'read'), 0, 'Read the item after updating')
  const denied = run(other ? executable(other) : process.execPath, 'read')
  assert.ok([-25293, -25308].includes(denied), `Foreign signature should be refused, got OSStatus ${denied}`)
  console.log('Protected item was readable after restart and update. An unrelated signature was denied.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
