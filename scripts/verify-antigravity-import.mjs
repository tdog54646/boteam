// Run after npm run build on macOS. OAuth and the CLI are local process fixtures.
// Desktop discovery, the wizard, account bindings, SQLite and Electron IPC are real.
import assert from 'node:assert/strict'
import { access, appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const work = 'work@example.test'
const personal = 'personal@example.test'
const ghost = 'boteam-only@example.test'
const fixtureState = email => JSON.stringify({ email, plan: 'Google AI Pro' })
const paths = root => {
  const native = join(dirname(root), 'native')
  return { native, bin: join(native,'bin','agy'), desktop: join(native,'Application Support','Antigravity'),
    cli: join(native,'.gemini','antigravity-cli'),
    stream: join(native,'browser-calls'), grant: join(native,'next-login.json'), profiles: join(root,'profiles') }
}
const setHint = (desktop, email) => writeFile(join(desktop,'app_storage.json'),
  JSON.stringify({ 'jetski.onboarding.lastLoginUsername': email }))

async function launchMain() {
  const { app } = await import('electron')
  const { Workspace } = await import('../desktop/workspace.mjs')
  const original = Workspace.prototype.handle
  const root = app.getPath('userData')
  assert.match(basename(dirname(root)), /^boteam-agy-import-/)
  const { native, bin, desktop, cli, stream, grant, profiles } = paths(root)
  Workspace.prototype.handle = function(method, payload) {
    if (!this.accounts.fixtureInstalled) {
      this.accounts.fixtureInstalled = true
      this.pickDirectory = async () => join(native,'manual','antigravity-cli')
      this.accounts.discoverySources = async provider => {
        if (provider !== 'antigravity') return [join(native,provider)]
        const found = []
        for (const source of [desktop,cli])
          if (await access(source).then(() => true, () => false)) found.push(source)
        return found
      }
      this.accounts.locate = async (provider, source) => {
        if (provider !== 'antigravity') return { bin: null, source, appInstalled: false }
        if (dirname(source) === profiles) {
          const login = await readFile(grant,'utf8')
          await writeFile(join(source,'fixture'), login, { flag: 'wx' })
            .catch(error => { if (error.code !== 'EEXIST') throw error })
        }
        const installed = await access(bin).then(() => true, () => false)
        const appInstalled = await access(desktop).then(() => true, () => false)
        return { bin: installed ? bin : null, source, appInstalled }
      }
      this.installAntigravityCli = async signal => {
        signal.throwIfAborted()
        await copyFile(bin + '.download',bin)
        return true
      }
      this.accounts.openUrl = async url => {
        assert.equal(new URL(url).hostname,'accounts.google.com')
        await appendFile(stream,'google\n')
      }
    }
    return original.call(this, method, payload)
  }
  await import('../desktop/main.mjs')
}

async function seedExternalInstall(root) {
  const { bin, desktop, grant, stream } = paths(root)
  const fixture = await readFile(new URL('../tests/antigravity-native-fixture.cjs', import.meta.url),'utf8')
  await mkdir(dirname(bin),{recursive:true})
  await writeFile(bin + '.download','#!' + process.execPath + '\n' + fixture,{mode:0o700})
  await mkdir(desktop,{recursive:true})
  await setHint(desktop,work)
  await writeFile(grant,fixtureState(work))
  await writeFile(stream,'')
}
async function seedCli(source, email) {
  await mkdir(source,{recursive:true,mode:0o700})
  await writeFile(join(source,'settings.json'),JSON.stringify({auth:{type:'oauth-personal'}}),{mode:0o600})
  await writeFile(join(source,'antigravity-oauth-token'),fixtureState(email),{mode:0o600})
}

async function dbRead(root, action) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(root,'workspace.sqlite3'),{readOnly:true})
  try { return action(db) } finally { db.close() }
}

// Set up an unrelated managed account after the first install has successfully imported
// the external account. Its presence exercises the historical false discovery.
async function addUnrelatedBinding(root) {
  const { Database } = await import('../desktop/database.mjs')
  const { profiles, bin } = paths(root)
  const source = join(profiles,'profile-Ghost1')
  await mkdir(source, {recursive:true,mode:0o700})
  await writeFile(join(source,'fixture'),fixtureState(ghost))
  const db = new Database(root)
  try {
    db.run('INSERT INTO accounts VALUES(?,?,?,?,?)','ghost','antigravity','google:' + ghost,
      JSON.stringify({email:ghost,source,origin:source,bin,status:'ready',plan:'pro',managed:true}),'')
    const account = db.get('SELECT * FROM accounts WHERE identity=?','google:' + work)
    const bot = db.get('SELECT * FROM bots WHERE accountId=?',account.id)
    const thread = db.get('SELECT chatId,threadId FROM threads WHERE botId=? AND accountId=?', bot.id, account.id)
    assert.ok(thread?.threadId, 'First message should have an associated native thread')
    await writeFile(join(JSON.parse(account.info).source,'session-canary'),'unchanged')
    return { accountId:account.id, botId:bot.id, ...thread, source:JSON.parse(account.info).source }
  } finally { db.db.close() }
}

async function verify() {
  assert.equal(process.platform,'darwin','Antigravity native isolation requires macOS')
  const { _electron, expect } = await import('@playwright/test')
  const sandbox = await realpath(await mkdtemp(join(tmpdir(),'boteam-agy-import-')))
  const root = join(sandbox,'workspace')
  const { native, desktop, cli, grant, stream, profiles } = paths(root)
  let app, page
  const errors = []
  const launch = async () => {
    app = await _electron.launch({args:[fileURLToPath(import.meta.url),'--user-data-dir=' + root]})
    assert.equal(await realpath(await app.evaluate(({app}) => app.getPath('userData'))),root)
    page = await app.firstWindow()
    page.setDefaultTimeout(26000)
    page.on('pageerror',error => errors.push(error.message))
  }
  const candidates = () => page.locator('.account-discovery')
  const row = email => candidates().locator('.detected-account').filter({hasText:email})
  const openDiscovery = async () => {
    await page.getByRole('button',{name:'设置',exact:true}).click()
    await page.getByRole('button',{name:'账号管理',exact:true}).click()
    await page.getByRole('button',{name:'检测本机账号',exact:true}).click()
  }
  const refresh = () => candidates().getByRole('button',{name:'重新检测',exact:true}).click()
  const accountCount = () => dbRead(root,db => db.prepare('SELECT count(*) AS n FROM accounts').get().n)
  const assertExternal = async email => {
    await expect(row(email)).toHaveCount(1)
    await expect(row(email).locator('.candidate-name code')).toHaveAttribute('title',desktop)
    await expect(candidates()).not.toContainText('BoTeam 独立配置')
    await expect(candidates()).not.toContainText('已导入')
    await expect(row(ghost)).toHaveCount(0)
  }
  try {
    await seedExternalInstall(root)
    await launch()
    await expect(page.getByRole('heading',{name:'导入本机账号'})).toBeVisible()
    await assertExternal(work)
    for (const provider of ['Codex','Claude Code','Antigravity'])
      await expect(candidates().getByText(provider,{exact:true})).toHaveCount(1)
    assert.equal(await accountCount(),0)
    assert.deepEqual(await readdir(profiles).catch(e => {if (e.code === 'ENOENT') return []; throw e}),[])
    const externalBefore = await readFile(join(desktop,'app_storage.json'),'utf8')
    await expect(row(work).getByRole('checkbox')).toBeDisabled()
    const manual = join(native,'manual','antigravity-cli')
    await seedCli(cli,'cli@example.test')
    await seedCli(manual,'manual@example.test')
    await refresh()
    await candidates().getByRole('button',{name:'选择其他配置目录'}).click()
    await page.getByRole('combobox',{name:'检测工具'}).selectOption('antigravity')
    await page.getByRole('button',{name:'选择目录并检测'}).click()
    const cliRow = source => candidates().locator('.detected-account').filter({has:page.getByTitle(source,{exact:true})})
    for (const source of [cli,manual])
      await expect(cliRow(source)).toContainText('安装后会核验此 CLI 配置的登录状态')
    await row(work).getByRole('button',{name:'安装官方 agy',exact:true}).click()
    await assertExternal(work)
    for (const source of [cli,manual]) {
      const nativeRow = cliRow(source)
      await expect(nativeRow.getByRole('checkbox')).toBeChecked({timeout:30000})
      await expect(nativeRow.getByRole('button',{name:'安装官方 agy'})).toHaveCount(0)
    }
    await cliRow(manual).locator('label.candidate').click()
    await refresh()
    await expect(candidates().getByRole('button',{name:'重新检测',exact:true})).toBeEnabled()
    await expect(cliRow(manual).getByRole('checkbox')).not.toBeChecked()
    await expect(cliRow(cli).getByRole('checkbox')).toBeChecked()
    await cliRow(cli).locator('label.candidate').click()
    await rm(cli,{recursive:true})
    await rm(manual,{recursive:true})
    await expect(row(work).getByRole('button',{name:'Google 授权并导入'})).toBeVisible()
    await row(work).locator('label.candidate').click()
    await candidates().getByRole('button',{name:'导入并继续'}).click()
    await expect(page.getByRole('heading',{name:'创建第一个 Bot'})).toBeVisible({timeout:35000})
    assert.equal(await accountCount(),1)
    assert.equal(await readFile(stream,'utf8'),'google\n')
    assert.equal(await readFile(join(desktop,'app_storage.json'),'utf8'),externalBefore)
    await page.getByPlaceholder('例如，代码助手').fill('项目助手')
    await page.getByRole('button',{name:'创建并开始聊天'}).click()
    const draft = page.getByRole('textbox', { name: /^(新对话消息|消息内容)$/ })
    await expect(draft).toBeVisible()
    assert.equal(await dbRead(root, db => db.prepare('SELECT COUNT(*) AS n FROM chats').get().n), 0)
    await draft.fill('验证首次订阅绑定。')
    await draft.press('Enter')
    await page.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(() => dbRead(root, db => db.prepare('SELECT status FROM tasks').get()?.status)).toBe('done')
    await app.close()
    const binding = await addUnrelatedBinding(root)
    await launch()
    await openDiscovery()
    await assertExternal(work)
    await expect(row(work).getByRole('checkbox')).toBeChecked()
    await candidates().getByRole('button',{name:'导入所选账号'}).click()
    await expect(candidates()).toHaveCount(0)
    assert.equal(await accountCount(),2)
    assert.equal(await readFile(stream,'utf8'),'google\n')
    assert.equal(await readFile(join(binding.source,'session-canary'),'utf8'),'unchanged')
    await dbRead(root,db => {
      assert.equal(db.prepare('SELECT id FROM accounts WHERE identity=?').get('google:' + work).id,binding.accountId)
      assert.equal(db.prepare('SELECT accountId FROM bots WHERE id=?').get(binding.botId).accountId,binding.accountId)
      assert.equal(db.prepare('SELECT threadId FROM threads WHERE chatId=?').get(binding.chatId).threadId,binding.threadId)
    })
    // The real external desktop switched accounts. The previously bound accounts
    // only exist in BoTeam now and must disappear from the discovery list.
    await setHint(desktop,personal)
    await openDiscovery()
    await assertExternal(personal)
    await expect(row(work)).toHaveCount(0)
    const authorize = () => row(personal).getByRole('button',{name:'Google 授权并导入',exact:true}).click()
    await writeFile(grant,JSON.stringify({email:personal,plan:'Google AI Pro',holdGrant:true}))
    await authorize()
    await expect.poll(() => readFile(stream,'utf8')).toBe('google\ngoogle\n')
    await row(personal).getByRole('button',{name:'取消授权',exact:true}).click()
    await expect(row(personal).getByRole('button',{name:'Google 授权并导入',exact:true})).toBeEnabled()
    await writeFile(grant,fixtureState(work))
    await authorize()
    await expect(row(personal)).toContainText(/不符|不匹配/)
    assert.equal(await accountCount(),2)
    await writeFile(grant,fixtureState(personal))
    await authorize()
    await expect.poll(accountCount).toBe(3)
    await expect(row(personal).getByRole('checkbox')).toBeChecked()
    await assertExternal(personal)
    await refresh()
    await expect(row(personal).getByRole('checkbox')).toBeChecked()
    await assertExternal(personal)
    await candidates().getByRole('button',{name:'导入所选账号'}).click()
    await expect(candidates()).toHaveCount(0)
    assert.equal(await accountCount(),3)
    assert.deepEqual((await readFile(stream,'utf8')).trim().split('\n'), Array(4).fill('google'))
    await app.close()
    await launch()
    await openDiscovery()
    await assertExternal(personal)
    await expect(row(personal).getByRole('checkbox')).toBeChecked()
    await expect(row(work)).toHaveCount(0)
    assert.deepEqual(errors,[])
    console.log('Electron passed: empty-workspace external discovery and first import, consistent source labels, repeat import with original Bot/thread, no BoTeam-only rows, external account switch, cancelled/mismatched grants and restart.')
  } finally {
    await app?.close().catch(()=>{})
    await rm(sandbox,{recursive:true,force:true})
  }
}

async function verifyCliFirstInstall() {
  const { _electron, expect } = await import('@playwright/test')
  const sandbox = await realpath(await mkdtemp(join(tmpdir(),'boteam-agy-import-cli-')))
  const root = join(sandbox,'workspace')
  const { desktop, cli, stream } = paths(root)
  let app
  try {
    await seedExternalInstall(root)
    await rm(desktop,{recursive:true})
    await mkdir(cli,{recursive:true,mode:0o700})
    const settings = JSON.stringify({auth:{type:'oauth-personal'}})
    await writeFile(join(cli,'settings.json'),settings,{mode:0o600})
    const login = fixtureState(personal)
    await writeFile(join(cli,'antigravity-oauth-token'),login,{mode:0o600})
    app = await _electron.launch({args:[fileURLToPath(import.meta.url),'--user-data-dir=' + root]})
    const page = await app.firstWindow()
    const cliRow = page.locator('.detected-account').filter({hasText:'Antigravity'})
    await expect(cliRow.locator('.candidate-name code')).toHaveAttribute('title',cli,{timeout:30000})
    await cliRow.getByRole('button',{name:'安装官方 agy'}).click()
    const row = page.locator('.detected-account').filter({hasText:personal})
    await expect(row.locator('.candidate-name code')).toHaveAttribute('title',cli,{timeout:30000})
    await expect(row.getByRole('checkbox')).toBeChecked()
    await expect(row.getByRole('button',{name:'Google 授权并导入'})).toHaveCount(0)
    await writeFile(join(cli,'antigravity-oauth-token'),fixtureState('changed@example.test'))
    await page.getByRole('button',{name:'导入并继续'}).click()
    await expect(row.getByRole('button',{name:'重新检测此来源'})).toBeVisible({timeout:30000})
    await expect(row.getByRole('button',{name:/授权并导入/})).toHaveCount(0)
    await writeFile(join(cli,'antigravity-oauth-token'),login)
    await row.getByRole('button',{name:'重新检测此来源'}).click()
    await expect(row.getByRole('button',{name:'重新检测此来源'})).toHaveCount(0)
    await page.getByRole('button',{name:'导入并继续'}).click()
    await expect(page.getByRole('heading',{name:'创建第一个 Bot'})).toBeVisible({timeout:30000})
    assert.equal(await readFile(stream,'utf8'),'')
    assert.equal(await readFile(join(cli,'antigravity-oauth-token'),'utf8'),login)
    assert.equal(await readFile(join(cli,'settings.json'),'utf8'),settings)
    const stored = await dbRead(root,db => db.prepare('SELECT identity,info FROM accounts').get())
    assert.equal(stored.identity,'google:' + personal)
    assert.equal(JSON.parse(stored.info).origin,cli)
    assert.notEqual(JSON.parse(stored.info).source,cli)
    console.log('Electron passed: external personal CLI profile on a new installation, native identity, one-click import, separate execution profile and unchanged original files.')
  } finally {
    await app?.close().catch(()=>{})
    await rm(sandbox,{recursive:true,force:true})
  }
}

if (process.versions.electron) await launchMain()
else {
  await verify()
  await verifyCliFirstInstall()
}
