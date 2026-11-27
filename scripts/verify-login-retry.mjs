// Run after npm run build. Only the native identity provider and browser are
// fixtures. Electron, renderer, account lifecycle, IPC and SQLite are real.
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function launchFixture() {
  const { app, BrowserWindow } = await import('electron')
  const { Workspace } = await import('../desktop/workspace.mjs')
  const root = app.getPath('userData')
  assert.match(basename(root), /^boteam-login-retry-/)
  const attempts = []
  const verified = new Map()
  let callbackPort = 0
  const missing = { status: 'missing', loginState: 'unknown' }
  const adapter = {
    async detect({ source, managed }) { return managed ? verified.get(source) || missing : missing },
    async prepare({ candidate }) { return { ...candidate } },
    async login({ signal, source }) {
      signal.throwIfAborted()
      const browser = new BrowserWindow({ show: false })
      const listener = createServer(socket => socket.end())
      const attempt = { browser, state: 'waiting' }
      try {
        // Reuse one loopback port for this test, as a native OAuth client does.
        // An overlapping attempt will get a real EADDRINUSE here.
        await new Promise((resolve, reject) =>
          listener.once('error', reject).listen(callbackPort, '127.0.0.1', resolve))
        callbackPort = listener.address().port
        signal.throwIfAborted()
        attempts.push(attempt)
        await new Promise((resolve, reject) => {
          const abort = () => {
            attempt.state = 'cancelled'
            // Native OAuth listeners can take a moment to release their port.
            setTimeout(() => reject(new Error('fixture login cancelled')), 160)
          }
          signal.addEventListener('abort', abort, { once: true })
          attempt.finish = email => {
            if (signal.aborted || attempt.state !== 'waiting') return false
            signal.removeEventListener('abort', abort)
            verified.set(source, { status: 'ready', loginState: 'signed-in', email,
              identity: 'codex:' + email, plan: 'pro', source })
            attempt.state = 'completed'
            resolve()
            return true
          }
        })
      } finally {
        if (listener.listening) await new Promise(resolve => listener.close(resolve))
        if (!browser.isDestroyed()) browser.destroy()
      }
    },
  }
  globalThis.testOAuth = {
    states: () => attempts.map(a => a.state),
    closeTab: index => attempts[index].browser.close(),
    finish: (index, email) => attempts[index].finish(email),
  }
  const original = Workspace.prototype.handle
  Workspace.prototype.handle = function(method, payload, context) {
    if (this.adapters.codex !== adapter) {
      for (const key of Object.keys(this.adapters)) this.adapters[key] = adapter
      this.accounts.discoverySources = async provider => [join(root, '..', 'external-' + provider)]
      this.accounts.locate = async (provider, source) => ({ source, bin: '/fixture/' + provider })
    }
    return original.call(this, method, payload, context)
  }
  await import('../desktop/main.mjs')
}

async function verify() {
  const { _electron, expect } = await import('@playwright/test')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'boteam-login-retry-')))
  let app
  try {
    app = await _electron.launch({ args: [fileURLToPath(import.meta.url), '--user-data-dir=' + root] })
    assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), root)
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    page.setDefaultTimeout(8000)
    const states = () => app.evaluate(() => globalThis.testOAuth.states())
    const snapshot = () => page.evaluate(async () => (await window.boteam.invoke('snapshot')).accounts)
    const complete = (index, email) => app.evaluate((_electron, args) => globalThis.testOAuth.finish(...args), [index,email])
    const dialog = page.getByRole('dialog')
    const add = () => page.getByRole('button', { name: '添加账号', exact: true }).click()
    const start = () => dialog.getByRole('button', { name: '开始授权', exact: true }).click()
    const waitForAttempt = index => expect.poll(async () => (await states())[index]).toBe('waiting')

    await page.getByRole('button', { name: '暂时跳过' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '账号管理', exact: true }).click()
    await add()
    await start()
    await waitForAttempt(0)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await add()
    await start()
    // This is the user's failing path: a second native grant must actually open.
    await waitForAttempt(1)
    await expect.poll(async () => (await states())[0]).toBe('cancelled')
    assert.equal(await complete(0, 'stale@example.test'), false)
    assert.equal((await snapshot()).length, 0)

    // Closing a third-party browser tab produces no OAuth callback in BoTeam.
    await app.evaluate(() => globalThis.testOAuth.closeTab(1))
    await dialog.getByRole('button', { name: '重新开始授权', exact: true }).click()
    await waitForAttempt(2)
    await expect.poll(async () => (await states())[1]).toBe('cancelled')
    await dialog.press('Escape')
    await add()
    await start()
    await waitForAttempt(3)
    await dialog.getByRole('button', { name: '取消授权', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await add()
    await start()
    await waitForAttempt(4)
    const email = 'work@example.test'
    assert.equal(await complete(4, email), true)
    await expect(dialog).toHaveCount(0)
    const accounts = await snapshot()
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].email, email)

    await page.getByRole('button', { name: '管理账号 ' + email }).click()
    await dialog.getByRole('button', { name: '重新授权', exact: true }).click()
    await start()
    await waitForAttempt(5)
    await dialog.getByRole('button', { name: '重新开始授权', exact: true }).click()
    await waitForAttempt(6)
    assert.equal(await complete(5, 'stale@example.test'), false)
    assert.equal(await complete(6, email), true)
    await expect(dialog).toHaveCount(0)
    assert.deepEqual((await snapshot()).map(a => [a.id, a.email]), [[accounts[0].id, email]])

    // Navigation destroys the old renderer without running React's cleanup.
    await add()
    await start()
    await waitForAttempt(7)
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '账号管理', exact: true }).click()
    await add()
    await start()
    await waitForAttempt(8)
    assert.equal(await complete(7, 'stale@example.test'), false)
    await dialog.getByRole('button', { name: '取消授权', exact: true }).click()
    await expect.poll(async () => (await states())[8]).toBe('cancelled')
    assert.deepEqual((await snapshot()).map(a => [a.id, a.email]), [[accounts[0].id, email]])
    assert.deepEqual(await states(), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'completed', 'cancelled', 'completed', 'cancelled', 'cancelled'])
    assert.deepEqual(errors, [])
    console.log('Electron passed: closing with X, Escape or Cancel, restarting after a closed browser tab or renderer reload, rejecting old grants, adding an account and reauthorizing the original binding.')
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
}
if (process.versions.electron) await launchFixture()
else await verify()
