import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverySources } from '../desktop/native.mjs'
import { detect, prepare, login, run } from '../desktop/adapters/antigravity.mjs'

test('desktop install is discoverable without a CLI, and cannot run through shared credentials', async t => {
  const source = await mkdtemp(join(tmpdir(), 'native-desktop-'))
  t.after(() => rm(source, { recursive:true, force:true }))
  await writeFile(join(source, 'app_storage.json'), JSON.stringify({'jetski.onboarding.lastLoginUsername':''}))
  const candidate = { source, bin: null, appInstalled: true }
  const found = await detect(candidate)
  assert.equal(found.status, 'blocked')
  assert.match(found.reason, /agy/)
  assert.ok(found.identity.startsWith('source:'))
  assert.equal((await prepare({ candidate: { ...candidate, ...found } })).source, candidate.source)
  await assert.rejects(
    run({ account: candidate, emit: () => assert.fail('no native prompt allowed') }),
    /隔离|身份/,
  )
})
test('absence is distinct from unverified CLI identity; isolated login must not switch a global account', async () => {
  assert.equal(
    (await detect({ source: '/missing', bin: null, appInstalled: false })).status,
    'missing',
  )
  assert.equal(
    (await detect({ source: '/existing', bin: '/example/agy', appInstalled: true })).status,
    'blocked',
  )
  await assert.rejects(login({ source: '/example', bin: '/example/agy' }), /隔离|身份/)
})

test('shows last signed-in email as historical and does not infer an active login from it', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const source = await mkdtemp(join(tmpdir(), 'agy-discovery-'))
  t.after(() => rm(source, { recursive: true, force: true }))
  await writeFile(
    join(source, 'app_storage.json'),
    JSON.stringify({
      'jetski.onboarding.lastLoginUsername': 'Member@Example.com',
      privateData: 'DONT_STORE_ME',
    }),
  )
  const result = await detect({ source, appInstalled: true })
  assert.equal(result.email, 'member@example.com')
  assert.equal(result.loginState, 'unknown')
  assert.match(result.reason, /上次登录/)
  assert.doesNotMatch(JSON.stringify(result), /DONT_STORE_ME/)
  // The path-derived identity stays constant when the desktop user switches.
  await writeFile(join(source, 'app_storage.json'), JSON.stringify({
    'jetski.onboarding.lastLoginUsername': 'another@example.com',
  }))
  await assert.rejects(prepare({ candidate: { source, appInstalled: true, ...result } }), /身份已变化/)
})

test('only official external sources populate a fresh installation and optional CLI is not an installation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'external-agy-sources-'))
  t.after(() => rm(home, { recursive:true, force:true }))
  const desktop = join(home, 'Library/Application Support/Antigravity')
  const ide = join(home, 'Library/Application Support/Antigravity IDE')
  const cli = join(home, '.gemini/antigravity-cli')
  await Promise.all([desktop, ide, cli, join(home, 'Library/Application Support/BoTeam/profiles/profile-Ab1100')]
    .map(dir => mkdir(dir, { recursive:true })))
  assert.deepEqual(await discoverySources('antigravity', home), [desktop, ide, cli])
  const unknown = join(home, 'unrelated')
  await mkdir(unknown)
  await writeFile(join(unknown, 'settings.json'), '{}')
  await writeFile(join(unknown, 'app_storage.json'), '{}')
  const result = await detect({ source:unknown, bin:'/optional/agy', cliInstalled:false, appInstalled:true })
  assert.equal(result.configFound, false)
  assert.equal(result.requiresAuthorization, false)
  assert.equal(result.identity, undefined)
  assert.match(result.reason, /未识别/)
  assert.equal((await detect({source:unknown, bin:'/optional/agy', cliInstalled:false})).status, 'missing')
  const nested = await detect({ source:home, appInstalled:true })
  assert.equal(nested.source, cli)
  assert.equal(nested.sourceKind, 'cli')
})

test('native CLI file login is validated and imported into a separate profile, including after account changes',
  { skip:process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'external-native-agy-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  const source = join(root, 'external', 'antigravity-cli')
  const profile = join(root, 'managed', 'profile-000000')
  const file = join(source, 'antigravity-oauth-token')
  const settings = join(source, 'settings.json')
  const fixture = await readFile(new URL('./antigravity-native-fixture.cjs', import.meta.url), 'utf8')
  const bin = join(root, 'agy')
  await Promise.all([mkdir(source,{recursive:true,mode:0o700}), mkdir(profile,{recursive:true,mode:0o700}),
    writeFile(bin, '#!' + process.execPath + '\n' + fixture, {mode:0o700})])
  await writeFile(settings, JSON.stringify({auth:{type:'oauth-personal'},model:'gemini-flash'}))
  const nativeState = email => JSON.stringify({email,plan:'Google AI Pro',secret:'do-not-expose-fixture'})
  const first = nativeState('first@example.test')
  await writeFile(file, first, {mode:0o600})
  const settingsBefore = await readFile(settings)
  const detected = await detect({ source, bin, cliInstalled:true })
  assert.deepEqual([detected.sourceKind, detected.email, detected.status, detected.model, detected.requiresAuthorization],
    ['cli','first@example.test','ready','gemini-flash',false])
  assert.doesNotMatch(JSON.stringify(detected), /do-not-expose/)
  const candidate = {...detected, bin}
  const installed = await prepare({candidate, profile})
  assert.equal(installed.source, profile)
  assert.equal(installed.origin, source)
  assert.equal(installed.managed, true)
  assert.equal((await detect({...installed,bin})).identity, detected.identity)
  const bound = join(profile,'.gemini','antigravity-cli','antigravity-oauth-token')
  assert.equal(await readFile(bound,'utf8'),first)
  assert.equal(await readFile(file,'utf8'),first)
  assert.deepEqual(await readFile(settings),settingsBefore)
  const replacement = join(root, 'managed', 'profile-111111')
  await mkdir(replacement, {mode:0o700})
  // Only the final execution directory reports this mismatched account.
  await writeFile(join(replacement, 'fixture'), nativeState('wrong-runtime@example.test'))
  await assert.rejects(prepare({candidate,profile:replacement,existing:installed}), /变化/)
  assert.equal(await readFile(bound,'utf8'),first)
  await assert.rejects(prepare({candidate,profile,existing:installed}), /独立/)
  await writeFile(file, nativeState('second@example.test'))
  const switched = join(root, 'managed', 'profile-222222')
  await mkdir(switched, {mode:0o700})
  await assert.rejects(prepare({candidate,profile:switched,existing:installed}),/变化/)
  assert.equal(await readFile(bound,'utf8'),first)
  await unlink(file)
  await symlink(bound,file)
  const redirected = await detect({source,bin})
  assert.notEqual(redirected.status,'ready')
  await writeFile(settings, JSON.stringify({ modelProvider:'gemini' }))
  assert.equal((await detect({source,bin})).requiresAuthorization,false)
})
