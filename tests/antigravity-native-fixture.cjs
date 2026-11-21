const fs = require('node:fs')
const { execSync, execFileSync } = require('node:child_process')
const { createInterface } = require('node:readline')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const home = process.env.HOME
const source = fs.existsSync(path.join(home, 'fixture'))
  ? path.join(home, 'fixture') : path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const state = JSON.parse(fs.readFileSync(source))
const args = process.argv.slice(2)
const save = (event) => fs.appendFileSync(path.join(home, 'seen'), JSON.stringify(event) + '\n')

if (args.includes('/usage')) {
  console.log(
    JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            { name: 'Gemini Pro', buckets: [{ window: 'weekly', remaining_fraction: 0.8 }] },
            {
              name: 'Gemini pool',
              description: 'Models within this group: Gemini Flash',
              buckets: [{ window: '5h', remaining_fraction: 0.4 }],
            },
          ],
        },
      },
    }),
  )
} else if (args[0] !== 'acp') {
  const settings = JSON.parse(args[args.indexOf('--settings') + 1])
  const metadata = {
    product: 'antigravity',
    agent_state: 'idle',
    email: state.email,
    plan_tier: state.plan,
    token: 'SHOULD_NOT_LEAK',
  }
  execSync(settings.statusLine.command, { input: JSON.stringify(metadata) })
  setInterval(() => {}, 1000)
} else {
  const sessions = new Map()
  const send = (frame) => console.log(JSON.stringify({ jsonrpc: '2.0', ...frame }))
  let promptId
  function config(s) {
    return [
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        currentValue: s.mode || 'default',
        options: (state.modes || ['default', 'plan', 'accept-edits']).map((value) => ({ value, name: value })),
      },
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: s.model,
        options: [
          { value: 'gemini-pro', name: 'Gemini Pro' },
          { value: 'gemini-flash', name: 'Gemini Flash' },
        ],
      },
      {
        id: 'thought_level',
        category: 'thought_level',
        type: 'select',
        currentValue: s.effort,
        options: (s.model === 'gemini-pro' ? ['low', 'high'] : ['low']).map((value) => ({
          value,
          name: value,
        })),
      },
    ]
  }
  const input = createInterface({ input: process.stdin })
  input.once('close', () => {
    if (promptId && state.simulateAsyncSave) {
      setTimeout(() => fs.writeFileSync(path.join(home, 'saved'), 'persisted'), 650)
    }
  })
  input.on('line', (line) => {
    const { id, method, params, result } = JSON.parse(line)
    const session = sessions.get(params?.sessionId)
    let reply = {}
    if (id === 900 && result) {
      save(result)
      send({ id: promptId, result: { stopReason: 'end_turn' } })
      return
    }
    if (method === 'initialize')
      reply = {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { ...(state.loadOnly ? {} : { resume: {} }), close: {} },
        },
        authMethods: [{ id: 'oauth-personal' }],
      }
    if (method === 'authenticate') {
      if (params.methodId !== 'oauth-personal' || state.failGrant) {
        send({ id, error: { code: -32000, message: 'Authentication failed' } })
        return
      }
      const url =
        state.authUrl ||
        'https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A24680%2Fauth%2Fcallback'
      execFileSync('open', [url], { stdio: 'ignore' })
      if (state.holdGrant) return
    }
    if (method === 'session/resume' && state.resumeError) {
      send({ id, error: state.resumeError })
      return
    }
    if (method === 'session/load') {
      // A real load may replay earlier events before returning the session.
      for (let i = 0; i < 20; i++)
        send({
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'old reply' },
            },
          },
        })
      send({
        id: 901,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { title: 'Old action' },
          options: [{ kind: 'allow_once', optionId: 'old' }],
        },
      })
    }
    if (['session/new', 'session/resume', 'session/load'].includes(method)) {
      const sessionId = params.sessionId || randomUUID()
      const current =
        method !== 'session/new'
          ? { model: 'gemini-flash', effort: 'low', mode: 'accept-edits' }
          : { model: 'gemini-pro', effort: 'high' }
      sessions.set(sessionId, current)
      if (state.commands) setTimeout(() => send({
        method: 'session/update', params: { sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: state.commands } },
      }), 15)
      reply = {
        sessionId,
        configOptions: config(current),
        _meta: { antigravity: { tier: { name: state.acpPlan || state.plan } } },
      }
    }
    if (method === 'session/close') sessions.delete(params.sessionId)
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') {
        session.model = params.value
        session.effort = 'low'
      } else if (params.configId === 'mode') session.mode = params.value
      else session.effort = params.value
      reply = { configOptions: config(session) }
    }
    if (method === 'session/prompt') {
      promptId = id
      save({ method, params, ...session })
      if (state.promptError || state.stopReason) {
        send(state.promptError ? { id, error: state.promptError } : { id, result: { stopReason: state.stopReason } })
        return
      }
      send({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'usage_update', used: 701, size: 65000 },
        },
      })
      send({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'reply' },
          },
        },
      })
      send({
        id: 900,
        method: 'session/request_permission',
        params: {
          sessionId: params.sessionId,
          toolCall: { title: 'Edit file', kind: 'edit' },
          options: [
            { optionId: 'one', kind: 'allow_once', name: 'Allow' },
            { optionId: 'no', kind: 'reject_once', name: 'Deny' },
          ],
        },
      })
      return
    }
    send({ id, result: reply })
  })
}
