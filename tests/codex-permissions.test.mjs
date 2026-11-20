import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { codexFullInvocation, protectedNativePaths } from '../desktop/codex-permissions.mjs'
const exec = promisify(execFile)

test(
  'macOS full task can work outside its project while native login files remain isolated',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'boteam-permissions-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const profiles = join(root, 'profiles')
    const profile = join(profiles, 'one')
    const source = join(profile, 'contexts', 'a'.repeat(64))
    const external = join(root, 'another-login')
    await mkdir(source, { recursive: true })
    await mkdir(external)
    for (const dir of [profile, source, external]) await writeFile(join(dir, 'auth.json'), 'dummy')
    const protectedPaths = protectedNativePaths(root, [
      { source: profile, credentialSource: external },
    ])
    async function run(bin, args) {
      const [command, argv] = codexFullInvocation(bin, args, source, protectedPaths)
      return exec(command, argv)
    }
    const outside = join(root, 'outside-project')
    await run('/usr/bin/touch', [outside])
    assert.equal(await readFile(outside, 'utf8'), '')
    await run('/usr/bin/touch', [join(source, 'session.sqlite')])
    for (const dir of [source, profile, external])
      await assert.rejects(
        run('/bin/cat', [join(dir, 'auth.json')]),
        /not permitted|Permission denied/i,
      )
    await assert.rejects(run('/bin/ls', [profiles]), /not permitted|Permission denied/i)
    assert.throws(() => codexFullInvocation('/bin/echo', [], profile, protectedPaths), /旧会话/)
  },
)
