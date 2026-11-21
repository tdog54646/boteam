import { execFile } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, basename, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { nativeEnv } from './native.mjs'

const exec = promisify(execFile)
async function git(cwd, args, signal) {
  try {
    const { stdout } = await exec('git', ['--no-pager','-c','core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c','core.fsmonitor=false','-c','color.ui=false', ...args], {
      cwd, signal, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      env: nativeEnv({ LC_ALL:'C', GIT_TERMINAL_PROMPT:'0', GIT_LITERAL_PATHSPECS:'1' }),
    })
    return stdout
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new Error('无法创建 Git 工作树：' + (error.stderr?.trim() || error.message).slice(0, 800), {cause:error})
  }
}

function inside(root, file) {
  const path = relative(root,file)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

async function makeParents(root, path) {
  let parent = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!(await lstat(parent)).isDirectory()) throw new Error('工作树的文件路径已变化，请重试。')
  }
}

async function copyUntracked(root, target, name, signal) {
  const source = join(root,name), dest = join(target,name)
  if (!inside(root,source) || !inside(target,dest) || await realpath(dirname(source)) !== dirname(source))
    throw new Error('未跟踪文件的路径已变化，请重试。')
  const info = await lstat(source)
  await makeParents(target, dirname(dest))
  if (info.isSymbolicLink()) return symlink(await readlink(source), dest)
  if (!info.isFile()) throw new Error('未跟踪项目包含嵌套仓库或特殊文件，无法复制：' + name)
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const opened = await input.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) throw new Error('未跟踪文件已变化，请重试。')
    await pipeline(input.createReadStream({autoClose:false}), createWriteStream(dest, {flags:'wx', mode:0o600}), { signal })
    const after = await input.stat()
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) throw new Error('未跟踪文件正在写入，请重试。')
    await chmod(dest, opened.mode & 0o777)
  } finally { await input.close() }
}

async function copyWorkingTree(repo, target, patch, signal) {
  const args = { source: (...args) => git(repo,args,signal), target: (...args) => git(target,args,signal) }
  const head = (await args.source('rev-parse','--verify','HEAD^{commit}')).trim()
  // A tree object captures the index including staged removals and executable
  // bits, without stashing changes or touching a source branch.
  const index = (await args.source('write-tree')).trim()
  const changes = await args.source('status','--porcelain=v2','-z','--ignore-submodules=none','--untracked-files=no')
  if (changes.split('\0').some(record => /^[12] [^ ]+ S.[MU]/.test(record)))
    throw new Error('子模块中仍有未提交的工作，请先在子模块内创建分支。')
  await args.source('diff','--binary','--full-index','--no-ext-diff','--no-textconv','--no-renames','--no-color','--output='+patch,'--')
  const untracked = await args.source('ls-files','--others','--exclude-standard','-z')
  await args.source('worktree','add','--quiet','--detach','--no-checkout','--',target,head)
  await args.target('read-tree','--reset','-u',index)
  if ((await stat(patch)).size) await args.target('apply','--binary','--whitespace=nowarn','--',patch)
  await unlink(patch)
  for (const name of untracked.split('\0').filter(Boolean)) {
    signal.throwIfAborted()
    await copyUntracked(repo,target,name,signal)
  }
  if ((await args.source('rev-parse','HEAD')).trim() !== head || (await args.source('write-tree')).trim() !== index)
    throw new Error('源工作树正在切换版本或更新暂存区，请重试。')
}

export async function createChatWorktrees(workspace, sourceId, members) {
  const signal = workspace.lifetime.signal
  const repos = new Map(), scopes = []
  for (const bot of members) {
    let cwd, root
    try {
      cwd = await realpath(await workspace.ensureChatDirectory(sourceId,bot))
      root = await realpath((await git(cwd,['rev-parse','--show-toplevel'],signal)).replace(/\r?\n$/, ''))
    } catch (error) {
      if (signal.aborted) throw error
      throw new Error('成员「' + bot.name + '」的工作目录需要是可读取的 Git 工作树。', {cause:error})
    }
    if (!repos.has(root)) repos.set(root, null)
    scopes.push({botId:bot.id, root, subdirectory:relative(root,cwd)})
  }
  const managed = join(await realpath(workspace.root),'worktrees')
  if ([...repos.keys()].some(root => inside(root,managed))) throw new Error('Git 源仓库包含 BoTeam 工作树存放目录，请使用独立的项目目录。')
  await mkdir(managed,{recursive:true,mode:0o700})
  if (await realpath(managed) !== managed) throw new Error('工作树存放目录不能是符号链接。')
  const container = await mkdtemp(join(managed,'chat-'))
  const created = await lstat(container)
  async function discard() {
    const current = await lstat(container).catch(() => null)
    if (!current || current.dev !== created.dev || current.ino !== created.ino) return
    for (const [repo,target] of repos) {
      if (target && await lstat(join(target,'.git')).catch(() => null))
        await git(repo,['worktree','remove','--force','--',target])
    }
    await rm(container,{recursive:true,force:true})
  }
  try {
    let i = 0
    for (const repo of repos.keys()) {
      const target = join(container, (++i) + '-' + (basename(repo) || 'repo'))
      repos.set(repo,target)
      await copyWorkingTree(repo,target,join(container,'unstaged.patch'),signal)
    }
    const directories = new Map()
    for (const {botId,root,subdirectory} of scopes) {
      const target = repos.get(root)
      const cwd = join(target,subdirectory)
      await makeParents(target,cwd)
      directories.set(botId,cwd)
    }
    return { directories, discard }
  } catch (error) {
    await discard()
    throw error
  }
}
