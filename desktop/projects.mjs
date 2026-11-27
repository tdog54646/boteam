import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { listGitWorktrees } from './panel-git.mjs'
import { protectedNativePaths } from './codex-permissions.mjs'
import { redact } from './native.mjs'
import { insertSection, requireSection, requireIdleChats } from './chat-management.mjs'

function canonicalFolder(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    throw new Error('请选择本机文件夹的绝对路径。')
  try {
    const canonical = realpathSync.native(path)
    if (!statSync(canonical).isDirectory()) throw new Error()
    accessSync(canonical, constants.R_OK | constants.X_OK)
    return canonical
  } catch { throw new Error('来源文件夹不存在或无法读取，请重新选择。') }
}

function validFolders(folders) {
  if (!Array.isArray(folders) || !folders.length) throw new Error('请为项目选择至少一个来源文件夹。')
  return [...new Set(folders.map(canonicalFolder))]
}

function projectName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(name.trim()))
    throw new Error('请输入 1 到 120 字的项目名称。')
  return redact(name.trim())
}

function requireProject(db, id) {
  if (typeof id !== 'string' || !db.get('SELECT 1 FROM projects WHERE id=?', id))
    throw new Error('项目已不存在。')
}

// The renderer selects a registered path. Resolve it again before opening or
// starting a chat so replacing a folder with a symlink cannot redirect either.
function registeredFolder(db, projectId, folder) {
  requireProject(db, projectId)
  const selected = folder === undefined
    ? db.get('SELECT path FROM project_folders WHERE projectId=? ORDER BY position LIMIT 1', projectId)
    : typeof folder === 'string' && db.get('SELECT path FROM project_folders WHERE projectId=? AND path=?', projectId, folder)
  if (!selected) throw new Error('请选择该项目的来源文件夹。')
  if (canonicalFolder(selected.path) !== selected.path) throw new Error('来源文件夹已移动，请在项目中重新选择。')
  return selected.path
}

function within(root, directory) {
  const rel = relative(root, directory)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

// Only a user importing a matching folder can adopt existing conversations.
// An explicit move, including removing a project, leaves a chat_projects row,
// so re-importing the same folder cannot undo a user's organization.
function adoptMatchingChats(workspace, projectId, folders) {
  const { db } = workspace
  const rows = db.all(`SELECT m.chatId,t.cwd AS threadCwd,f.cwd AS forkCwd,b.cwd AS botCwd,
    json_extract(a.info,'$.cwd') AS accountCwd FROM members m JOIN bots b ON b.id=m.botId
    LEFT JOIN threads t ON t.chatId=m.chatId AND t.botId=m.botId
    LEFT JOIN fork_member_context f ON f.chatId=m.chatId AND f.botId=m.botId
    LEFT JOIN accounts a ON a.id=b.accountId
    WHERE NOT EXISTS(SELECT 1 FROM chat_projects p WHERE p.chatId=m.chatId)`)
  if (!rows.length) return
  let excluded
  try {
    excluded = [realpathSync.native(workspace.root), ...protectedNativePaths(workspace.root,
      db.all('SELECT id FROM accounts').map(a => db.account(a.id)))]
  } catch {
    // A broken historical account path cannot establish which chats are safe to adopt.
    return
  }
  const cache = new Map(), chats = new Map()
  for (const row of rows) {
    const path = row.threadCwd || row.forkCwd || row.botCwd || row.accountCwd
    if (!cache.has(path)) {
      let directory
      try { directory = canonicalFolder(path) } catch { /* Missing historical working directory. */ }
      const outside = directory && !excluded.some(privatePath => within(privatePath, directory) || within(directory, privatePath))
      cache.set(path, outside ? directory : null)
    }
    if (!chats.has(row.chatId)) chats.set(row.chatId, new Set())
    chats.get(row.chatId).add(cache.get(path))
  }
  for (const [chatId, directories] of chats) {
    if ([...directories].every(cwd => cwd && folders.some(folder => within(folder, cwd))))
      db.run('INSERT INTO chat_projects(chatId,projectId) VALUES(?,?)', chatId, projectId)
  }
}

function saveFolders(db, projectId, folders) {
  db.run('DELETE FROM project_folders WHERE projectId=?', projectId)
  for (const [position,path] of folders.entries())
    db.run('INSERT INTO project_folders(projectId,path,position) VALUES(?,?,?)', projectId,path,position)
}

export function draftProjectCwd(db, { projectId, folder }) {
  if (projectId != null) return registeredFolder(db, projectId, folder)
  if (folder != null) throw new Error('请先选择项目，再指定来源文件夹。')
  return null
}

export function configureNewChatProject(db, chatId, draft) {
  const { projectId } = draft
  const cwd = draftProjectCwd(db, draft)
  if (!cwd) {
    // Remember an explicit opt-out when a later folder import matches the Bot's cwd.
    if (projectId === null) db.run('INSERT INTO chat_projects(chatId) VALUES(?)',chatId)
    return
  }
  db.run('INSERT INTO chat_projects(chatId,projectId,cwd) VALUES(?,?,?)', chatId,projectId,cwd)
}

export function chatProjectCwd(db, chatId) {
  return chatId ? db.get('SELECT cwd FROM chat_projects WHERE chatId=?',chatId)?.cwd ?? null : null
}

export function inheritProject(db, sourceChatId, chatId, destinationCwd = null) {
  db.run(`INSERT INTO chat_projects(chatId,projectId,cwd)
    SELECT ?,projectId,coalesce(?,cwd) FROM chat_projects WHERE chatId=?`, chatId,destinationCwd,sourceChatId)
}

export async function projectWorktrees(workspace, projectId) {
  requireProject(workspace.db, projectId)
  const folders = workspace.db.all('SELECT path FROM project_folders WHERE projectId=? ORDER BY position', projectId)
  const rows = new Map(), issues = []
  for (const { path } of folders) {
    try {
      const directory = registeredFolder(workspace.db, projectId, path)
      for (const row of await listGitWorktrees(directory, workspace.lifetime.signal)) rows.set(row.path, row)
    } catch (error) {
      workspace.lifetime.signal.throwIfAborted()
      issues.push({ path, message: redact(error.message).slice(0,500) })
    }
  }
  return { rows: [...rows.values()], issues }
}

export function projectDirectories(workspace, projectId) {
  requireProject(workspace.db, projectId)
  const chats = workspace.db.all(`SELECT c.id,c.name FROM chat_projects p JOIN chats c ON c.id=p.chatId
    WHERE p.projectId=? ORDER BY c.updatedAt DESC`, projectId)
  return chats.flatMap(chat => workspace.chatDirectories(chat.id).map(({ names, directory }) =>
    ({ chatId:chat.id, chatName:chat.name, names, directory })))
}

export function projectSnapshot(db) {
  return db.all(`SELECT p.id,p.name,p.pinned,p.sectionId,(SELECT json_group_array(path ORDER BY position)
    FROM project_folders WHERE projectId=p.id) AS folders FROM projects p ORDER BY p.pinned DESC,p.rowid`)
    .map(p => ({ ...p, pinned: Boolean(p.pinned), folders: JSON.parse(p.folders) }))
}

// Both initial selection and import-and-select call this inside their own transaction.
function bindInitialChatProject(workspace, p) {
  const { db } = workspace
  const { chatId, projectId } = p
  if (typeof chatId !== 'string' || !db.get('SELECT 1 FROM initial_project_chats WHERE chatId=?',chatId))
    throw new Error('仅能在新聊天开始前选择工作项目。')
  requireIdleChats(workspace, [chatId])
  const current = db.get('SELECT projectId,cwd FROM chat_projects WHERE chatId=?',chatId)
  if ((p.expectedProjectId !== undefined && p.expectedProjectId !== (current?.projectId ?? null)) ||
      (p.expectedProjectCwd !== undefined && p.expectedProjectCwd !== (current?.cwd ?? null)))
    throw new Error('聊天项目已在其他窗口修改，请重新选择。')
  const cwd = projectId === null ? null : registeredFolder(db,projectId)
  if ((current?.cwd ?? null) !== cwd) {
    if (workspace.panel.pendingWrites.has(chatId)) throw new Error('请等待工作区文件保存完成后再切换项目。')
    if (workspace.panel.terminals.hasLiveChat(chatId) || workspace.hasWindowChatTerminal?.(chatId))
      throw new Error('请关闭此聊天的终端后再切换项目。')
  }
  db.run(`INSERT INTO chat_projects(chatId,projectId,cwd) VALUES(?,?,?)
    ON CONFLICT(chatId) DO UPDATE SET projectId=excluded.projectId,cwd=excluded.cwd`,chatId,projectId,cwd)
  return { projectId, cwd }
}

export function manageProject(workspace, method, p) {
  const { db } = workspace
  if (method === 'setInitialChatProject') {
    const binding = db.transaction(() => bindInitialChatProject(workspace,p))
    workspace.notify()
    return binding
  }
  if (method === 'createProject') {
    const folders = validFolders(p.folders)
    const name = projectName(p.name ?? (basename(folders[0]) || folders[0]))
    const id = randomUUID()
    db.transaction(() => {
      db.run('INSERT INTO projects(id,name) VALUES(?,?)',id,name)
      saveFolders(db,id,folders)
      if (p.initialChat !== undefined) bindInitialChatProject(workspace,{...p.initialChat, projectId:id})
      adoptMatchingChats(workspace,id,folders)
    })
    workspace.notify()
    return id
  }
  if (method === 'moveChatToProject') {
    if (typeof p.chatId !== 'string' || !db.get('SELECT 1 FROM chats WHERE id=?', p.chatId)) throw new Error('聊天已不存在。')
    if (p.projectId !== null) requireProject(db,p.projectId)
    db.run(`INSERT INTO chat_projects(chatId,projectId) VALUES(?,?)
      ON CONFLICT(chatId) DO UPDATE SET projectId=excluded.projectId`, p.chatId,p.projectId)
    workspace.notify()
    return
  }
  requireProject(db,p.projectId)
  switch (method) {
    case 'moveProjectToSection':
    case 'createChatSection': {
      if (p.chatId != null) throw new Error('请选择要移入分区的项目或聊天。')
      const sectionId = db.transaction(() => {
        requireProject(db, p.projectId)
        const id = method === 'createChatSection' ? insertSection(db,p.name) : p.sectionId
        requireSection(db,id)
        db.run('UPDATE projects SET sectionId=?,pinned=0 WHERE id=?',id,p.projectId)
        return id
      })
      workspace.notify()
      return sectionId
    }
    case 'archiveProjectChats': {
      const count = db.transaction(() => {
        requireProject(db, p.projectId)
        const ids = db.all(`SELECT p.chatId FROM chat_projects p LEFT JOIN chat_organization o ON o.chatId=p.chatId
          WHERE p.projectId=? AND coalesce(o.archived,0)=0`,p.projectId).map(row => row.chatId)
        if (p.expectedChatIds !== undefined) {
          if (!Array.isArray(p.expectedChatIds) || p.expectedChatIds.some(id => typeof id !== 'string'))
            throw new Error('项目聊天列表无效。')
          const confirmed = new Set(p.expectedChatIds)
          if (ids.some(id => !confirmed.has(id))) throw new Error('项目聊天已在其他窗口修改，请重新确认归档。')
        }
        if (!ids.length) return 0
        requireIdleChats(workspace, ids)
        db.run(`INSERT INTO chat_organization(chatId,archived)
          SELECT value,1 FROM json_each(?) WHERE true
          ON CONFLICT(chatId) DO UPDATE SET archived=1`, JSON.stringify(ids))
        return ids.length
      })
      if (count) workspace.notify()
      return count
    }
    case 'updateProject': {
      db.transaction(() => {
        const original = db.all('SELECT path FROM project_folders WHERE projectId=? ORDER BY position',p.projectId)
          .map(f => f.path)
        if (p.expected !== undefined && (!p.expected ||
            p.expected.name !== db.get('SELECT name FROM projects WHERE id=?',p.projectId)?.name ||
            !Array.isArray(p.expected.folders) || p.expected.folders.length !== original.length ||
            original.some((path,index) => p.expected.folders[index] !== path)))
          throw new Error('项目已在其他窗口修改，请重新打开编辑。')
        const folders = p.folders === undefined ? null : validFolders(p.folders)
        const name = p.name === undefined ? null : projectName(p.name)
        if (!folders && !name) throw new Error('请选择要更改的项目设置。')
        if (name) db.run('UPDATE projects SET name=? WHERE id=?',name,p.projectId)
        if (folders) {
          saveFolders(db,p.projectId,folders)
          if (folders.some(f => !original.includes(f))) adoptMatchingChats(workspace,p.projectId,folders)
        }
      })
      break
    }
    case 'setProjectPinned':
      if (typeof p.pinned !== 'boolean') throw new Error('项目置顶状态无效。')
      db.run('UPDATE projects SET pinned=? WHERE id=?',Number(p.pinned),p.projectId)
      break
    case 'removeProject':
      db.run('DELETE FROM projects WHERE id=?', p.projectId)
      break
    case 'openProjectFolder':
      if (typeof p.folder !== 'string') throw new Error('请选择该项目的来源文件夹。')
      return workspace.openProjectDirectory(registeredFolder(db,p.projectId,p.folder))
    case 'revealProjectFolder':
      return workspace.revealProjectDirectory(registeredFolder(db,p.projectId))
    default: throw new Error('未知的项目操作。')
  }
  workspace.notify()
}
