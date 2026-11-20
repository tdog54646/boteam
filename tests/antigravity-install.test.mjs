import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { installAntigravityCli } from '../desktop/antigravity-install.mjs'
import { locate } from '../desktop/native.mjs'

const payload = Buffer.from('Not an executable')
const published = {
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/test/agy',
  sha512: createHash('sha512').update(payload).digest('hex'),
}
test('official CLI installation rejects untrusted downloads and leaves an existing tool intact', {
  skip: process.platform !== 'darwin',
}, async t => {
  const binDir = await mkdtemp(join(tmpdir(), 'boteam-install-'))
  t.after(() => rm(binDir, { recursive: true, force: true }))
  async function attempt(manifest) {
    await installAntigravityCli({ binDir, download: async (url, file) => {
      await writeFile(file, url.includes('/manifests/') ? JSON.stringify(manifest) : payload)
    } })
  }
  await assert.rejects(attempt({ ...published, url:'https://example.com/agy' }), /发行/)
  await assert.rejects(attempt({ ...published, sha512:'0'.repeat(128) }), /校验/)
  await assert.rejects(attempt(published), /签名/)
  assert.deepEqual(await readdir(binDir), [])
  const existing = join(binDir, 'agy')
  await writeFile(existing, 'local tool', { mode: 0o700 })
  await assert.rejects(attempt(published), /已有/)
  assert.equal(await readFile(existing, 'utf8'), 'local tool')
})

test('an agy on PATH pointing into BoTeam data never counts as the external CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'boteam-locate-'))
  const userData = join(root, 'workbench'), privateDir = join(userData, 'profiles', 'account')
  const linked = join(root, 'linked'), external = join(root, 'native')
  const previousPath = process.env.PATH
  t.after(async () => {
    process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  })
  for (const dir of [privateDir, linked, external]) await mkdir(dir, { recursive: true })
  await writeFile(join(privateDir, 'agy'), '', { mode: 0o700 })
  await symlink(join(privateDir, 'agy'), join(linked, 'agy'))
  await writeFile(join(external, 'agy'), '', { mode: 0o700 })
  process.env.PATH = [linked, privateDir, external].join(delimiter)
  const found = await locate('antigravity', undefined, { userData })
  assert.equal(found.bin, join(external, 'agy'))
  assert.equal(found.cliInstalled, true)
})
