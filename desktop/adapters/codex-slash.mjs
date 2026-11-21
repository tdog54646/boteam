import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { nativeEnv, redact } from '../native.mjs'
import { nativeError } from './codex-rpc.mjs'
import { contextUsage } from './usage.mjs'

const execute = promisify(execFile)
const schemas = new Map()

// Codex exposes its RPC methods through its own schema generator. The TUI
// shortcuts below are offered only if their backing method is installed.
async function exportedMethods(bin) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'boteam-codex-schema-'))
  try {
    await execute(bin, ['app-server', 'generate-json-schema', '--experimental', '--out', scratch], {
      cwd: scratch,
      env: nativeEnv({ CODEX_HOME: scratch }),
      timeout: 8000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    const schema = JSON.parse(await fs.readFile(path.join(scratch, 'ClientRequest.json'), 'utf8'))
    return new Set(schema.oneOf.flatMap((request) => request.properties?.method?.enum || []))
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

export async function installedMethods(bin) {
  const { dev, ino, mtimeMs, size } = await fs.stat(bin)
  const version = [dev, ino, mtimeMs, size].join(':')
  let record = schemas.get(bin)
  if (record?.version !== version) {
    record = { version, methods: exportedMethods(bin) }
    schemas.set(bin, record)
  }
  try {
    return await record.methods
  } catch (error) {
    if (schemas.get(bin) === record) schemas.delete(bin)
    throw error
  }
}

export function codexCommands(methods, actions) {
  if (!methods) return []
  const commands = []
  const add = (method, name, title, description, action, extra = {}) => {
    if (methods.has(method)) commands.push({ name, title, description, action, ...extra })
  }
  add('mcpServerStatus/list', 'mcp', 'MCP', '显示 MCP 服务器状态', 'mcp')
  add('account/rateLimits/read', 'status', '使用情况', '查看当前账号的订阅额度', 'quota')
  add('thread/compact/start', 'compact', '压缩', '压缩当前成员的原生会话上下文', 'compact')
  add('review/start', 'review', '代码审查', '审查工作目录的未提交改动，或指定审查内容', 'review', {
    argumentHint: '审查说明（可选）',
  })
  add('model/list', 'model', '模型与推理', '选择模型和思考强度', 'model')
  add('thread/start', 'permissions', '权限', '更改工具审批与文件访问权限', 'permission')
  if (actions.plan) add('collaborationMode/list', 'plan', '计划模式', '切换原生计划模式', 'plan')
  if (actions.goal) add('thread/goal/set', 'goal', '目标', '设置或继续当前成员的原生目标', 'goal')
  if (actions.extensions.some((entry) => entry.kind === 'skill'))
    add('skills/list', 'skills', '技能', '选择此工作目录中可用的技能', 'skills')
  add('thread/start', 'new', '新聊天', '与这个 Bot 开始新的私聊', 'new')
  if (methods.has('thread/read'))
    add('thread/fork', 'fork', '创建聊天分支', '在新的私聊中接续此成员的原生历史', 'fork')
  return commands
}

const connectionLabels = {
  notStarted: '未启动', starting: '正在连接', connected: '已连接', failed: '连接失败',
  authenticationRequired: '需要登录', cancelled: '已取消', disabled: '已停用',
}
const authLabels = {
  notLoggedIn: '未登录', oAuth: 'OAuth', bearerToken: '令牌认证', unsupported: '不支持认证查询',
}

export async function mcpInfo(rpc, threadId) {
  const lines = []
  const seen = new Set()
  let cursor
  do {
    const page = await rpc.request('mcpServerStatus/list', {
      threadId, detail: 'toolsAndAuthOnly', limit: 24, ...(cursor && { cursor }),
    }, 10000)
    if (!Array.isArray(page?.data)) throw new Error('Codex 未返回 MCP 服务器列表。')
    for (const server of page.data) {
      if (lines.length >= 48) break
      const name = redact(server.name).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 96)
      const connection = Object.hasOwn(connectionLabels, server.runtimeStatus) && connectionLabels[server.runtimeStatus]
      const auth = Object.hasOwn(authLabels, server.authStatus) && authLabels[server.authStatus]
      const tools = server.toolsError ? '工具列表不可用' : Object.keys(server.tools || {}).length + ' 个工具'
      lines.push([name || 'MCP 服务器', connection, auth, tools].filter(Boolean).join(' · '))
    }
    cursor = page.nextCursor
    if (cursor && (lines.length >= 48 || seen.has(cursor) || seen.size >= 2)) {
      lines.push('仅显示部分服务器。')
      break
    }
    seen.add(cursor)
  } while (cursor)
  return { title: 'MCP 服务器', lines: lines.length ? lines : ['当前工作目录未配置 MCP 服务器。'] }
}

export async function compactThread(rpc, scope, opened) {
  const session = opened.thread.id
  // The start response has no turn ID. A contextCompaction item (or the
  // native legacy notification) ties the subsequent completion to this task.
  await rpc.request('thread/compact/start', { threadId: session })
  let turn, compacted = false, usageModel = opened.model
  for (;;) {
    const message = await rpc.next()
    const p = message.params || {}
    if (message.method === 'boteam/refreshRejected')
      throw new Error('Codex 请求刷新订阅凭据，请刷新原登录或重新授权后重试。')
    if (message.id !== undefined) {
      rpc.unsupported(message.id)
      continue
    }
    if (p.threadId !== session) continue
    if (message.method === 'turn/started' && !turn) turn = p.turn?.id
    if (!turn || (p.turnId || p.turn?.id) !== turn) continue
    if (message.method === 'model/rerouted' && typeof p.toModel === 'string' && p.toModel)
      usageModel = p.toModel
    if ((message.method === 'item/completed' && p.item?.type === 'contextCompaction') ||
        message.method === 'thread/compacted') compacted = true
    if (message.method === 'thread/tokenUsage/updated') {
      const { last, modelContextWindow } = p.tokenUsage || {}
      const value = contextUsage(last?.totalTokens, modelContextWindow, usageModel)
      if (value) await scope.emit({ type: 'context', value })
    }
    if (message.method !== 'turn/completed') continue
    if (p.turn.status === 'interrupted') throw new Error('Codex 上下文压缩已停止。')
    if (p.turn.status !== 'completed') throw nativeError(p.turn.error?.message, p.turn.error?.codexErrorInfo)
    if (!compacted && !p.turn.items?.some((item) => item.type === 'contextCompaction'))
      throw new Error('Codex 未确认原生上下文压缩。')
    await scope.emit({ type: 'text', value: 'Codex 已压缩此会话的上下文。' })
    return
  }
}
