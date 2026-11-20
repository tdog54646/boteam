import { constants, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

async function readThread(rpc, threadId) {
  const { thread } = await rpc.request('thread/read', { threadId, includeTurns: false })
  if (thread?.id !== threadId || thread.ephemeral !== false || thread.modelProvider !== 'openai')
    throw new Error('Codex 未确认所选会话的持久化历史。')
  return thread
}

// Only the rollout that the account-bound native server identifies for this
// exact thread can cross into the destination. Other chats and SQLite stores
// may contain unrelated history and are never part of a branch snapshot.
async function rolloutLocation(thread, home) {
  if (typeof thread.path !== 'string' || !path.isAbsolute(thread.path) ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(thread.id))
    throw new Error('Codex 未报告可独立保存的会话历史路径。')
  const root = await fs.realpath(home)
  const file = await fs.realpath(thread.path)
  const relative = path.relative(root, file)
  const parts = relative.split(path.sep)
  if (parts.length !== 5 || parts[0] !== 'sessions' || !/^\d{4}$/.test(parts[1]) ||
      !/^\d{2}$/.test(parts[2]) || !/^\d{2}$/.test(parts[3]) ||
      !parts[4].startsWith('rollout-') || !parts[4].endsWith('-' + thread.id + '.jsonl') ||
      ![path.join(root, relative), path.join(home, relative)].includes(path.normalize(thread.path)))
    throw new Error('Codex 会话历史路径超出该聊天的独立目录。')
  return { file, relative }
}

async function snapshot(source, destination, signal) {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await input.stat()
    if (!before.isFile() || before.size === 0 || (process.getuid && before.uid !== process.getuid()))
      throw new Error('无法核验 Codex 会话历史文件。')
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await pipeline(input.createReadStream({ end: before.size - 1 }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
    const after = await fs.lstat(source)
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('原生会话历史正在写入，请在任务结束后重试。')
  } finally {
    await input.close()
  }
}

export async function stageFork(rpc, scope, home, destination) {
  // Paginated forks may still refer to their parent after restart. Keep
  // immutable point-in-time copies of this lineage under the new CODEX_HOME.
  let id = scope.threadId, stagedSource
  const visited = new Set()
  while (id) {
    scope.signal?.throwIfAborted()
    if (visited.has(id)) throw new Error('Codex 分支历史包含循环引用。')
    visited.add(id)
    const thread = await readThread(rpc, id)
    if (id === scope.threadId &&
        (await fs.realpath(thread.cwd)) !== (await fs.realpath(scope.cwd)))
      throw new Error('Codex 会话的工作目录与当前聊天不一致。')
    const { file, relative } = await rolloutLocation(thread, home)
    const staged = path.join(destination, relative)
    await snapshot(file, staged, scope.signal)
    if (id === scope.threadId) stagedSource = staged
    id = thread.forkedFromId
  }
  return stagedSource
}

export async function verifyFork(rpc, { threadId, parentId, home }) {
  const thread = await readThread(rpc, threadId)
  if (thread.forkedFromId !== parentId) throw new Error('Codex 未确认新分支的来源。')
  await rolloutLocation(thread, home)
}
