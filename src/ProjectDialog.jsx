import { useLanguage } from "./preferences";
import React, { useEffect, useRef, useState } from "react";
import { Folder, FolderPlus, X } from "lucide-react";
import { Button, Field, IconButton, Modal, Notice, errorText } from "./ui";
import "./project-sidebar.css";

export function folderName(path) {
  return path.split(/[/\\]/).filter(Boolean).at(-1) || path;
}

export function ProjectDialog({ project, initialFolder, initialChat, confirmRemoval = false, invoke, onDone, onClose }) {
  const tr = useLanguage();
  const [expected] = useState(() => project && ({ name: project.name, folders: [...project.folders] }));
  const [folders, setFolders] = useState(() => project?.folders || (initialFolder ? [initialFolder] : []));
  const [name, setName] = useState(() => project?.name || (initialFolder ? folderName(initialFolder) : ""));
  const [removing, setRemoving] = useState(confirmRemoval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelButton = useRef(null);
  const nameInput = useRef(null);
  const wasRemoving = useRef(false);
  useEffect(() => {
    if (removing) cancelButton.current?.focus();
    else if (wasRemoving.current) nameInput.current?.focus();
    wasRemoving.current = removing;
  }, [removing]);

  async function addFolder() {
    setBusy(true);
    setError("");
    try {
      const folder = await invoke("pickDirectory");
      if (folder) {
        setFolders(current => current.includes(folder) ? current : [...current, folder]);
        if (!name.trim()) setName(folderName(folder));
      }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || (!removing && (!folders.length || !name.trim()))) return;
    setBusy(true);
    setError("");
    try {
      let createdId;
      if (removing) await invoke("removeProject", { projectId: project.id });
      else if (project) await invoke("updateProject", { projectId: project.id, name: name.trim(), folders, expected });
      else createdId = await invoke("createProject", { name: name.trim(), folders, initialChat });
      await onDone(createdId);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function cancel() {
    if (busy) return;
    if (removing && !confirmRemoval) { setRemoving(false); setError(""); }
    else onClose();
  }

  return <div className="project-dialog-shell">
    <Modal title={removing ? tr("移除本地项目", "Remove local project") : project ? tr("编辑项目", "Edit project") : tr("导入本地项目", "Import local project")} onClose={cancel}>
      <form onSubmit={save}>
        {removing ? <p className="project-remove-message">{tr("从侧栏移除「", "Remove “")}{project.name}{tr("」？聊天会保留在工作台中，磁盘上的文件夹也会保留。", "” from the sidebar? Chats will remain in your workspace and folders will stay on disk.")}</p> : <>
          <label className="project-name-field">
            <span><Folder size={18} /></span>
            <input ref={nameInput} autoComplete="off" data-autofocus aria-label={tr("项目名称", "Project name")} placeholder={tr("项目名称", "Project name")} value={name}
              onChange={e => setName(e.target.value)} disabled={busy} />
          </label>
          <div className="project-folder-heading" id="project-source-heading">{tr("源文件夹", "Source folders")}</div>
          <div className="project-folder-list" role="group" aria-labelledby="project-source-heading">
            {folders.map((folder, index) => <div key={folder} className="project-folder-item">
              <Folder size={16} /><span title={folder}>{folderName(folder)}</span>
              {folders.length > 1 && (index === 0 ? <small className="project-primary-label">{tr("主要", "Primary")}</small> : <button type="button" disabled={busy} className="project-primary-button" aria-label={tr(`将 ${folderName(folder)} 设为主要`, `Set ${folderName(folder)} as primary`)}
                onClick={() => setFolders([folder, ...folders.filter(path => path !== folder)])}>{tr("设为主要", "Set as primary")}</button>)}
              <IconButton label={tr(`移除文件夹 ${folderName(folder)}`, `Remove folder ${folderName(folder)}`)} icon={X} disabled={busy} onClick={() => setFolders(folders.filter(path => path !== folder))}/>
            </div>)}
            <button type="button" className="project-folder-add" disabled={busy} onClick={addFolder}><FolderPlus size={16}/>{tr("添加文件夹", "Add folder")}</button>
          </div>
        </>}
        <Notice>{error}</Notice>
        <footer className="project-dialog-footer">
          {project && !removing && <Button className="project-remove" disabled={busy} onClick={() => { setRemoving(true); setError(""); }}>{tr("移除本地项目", "Remove local project")}</Button>}
          <Button ref={cancelButton} className="project-cancel" disabled={busy} onClick={cancel}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant={removing ? "danger" : "primary"} busy={busy} disabled={!removing && (!folders.length || !name.trim())}>{removing ? tr("移除", "Remove") : project ? tr("保存", "Save") : tr("导入", "Import")}</Button>
        </footer>
      </form>
    </Modal>
  </div>;
}

export function ProjectActionDialog({ action, project, expectedChatIds, invoke, onDone, onClose }) {
  const tr = useLanguage();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (action === "remove") return <ProjectDialog project={project} confirmRemoval invoke={invoke} onDone={onDone} onClose={onClose}/>;
  const section = action === "section";
  async function submit(event) {
    event.preventDefault();
    if (pending.current || (section && !name.trim())) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (section) await invoke("createChatSection", { projectId: project.id, name: name.trim() });
      else await invoke("archiveProjectChats", { projectId: project.id, expectedChatIds });
      await onDone();
    } catch (e) { setError(errorText(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Modal title={section ? tr("新建分区", "New section") : tr("归档聊天", "Archive chat")} onClose={() => { if (!pending.current) onClose(); }}>
    <form onSubmit={submit}>
      {section ? <Field label={tr("分区名称", "Section name")}><input data-autofocus type="text" value={name} required maxLength={120}
        onChange={event => setName(event.target.value)} disabled={busy}/></Field>
        : <p className="project-remove-message">{tr(
          `将「${project.name}」中的 ${expectedChatIds.length} 个聊天归档？你可以在「设置 → 已归档会话」中恢复聊天。`,
          `Archive ${expectedChatIds.length} chats in “${project.name}”? You can restore them in Settings → Archived chats.`,
        )}</p>}
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button data-autofocus={section ? undefined : true} disabled={busy} onClick={onClose}>{tr("取消", "Cancel")}</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={section ? !name.trim() : !expectedChatIds.length}>{section ? tr("创建并移入", "Create and move") : tr("归档", "Archive")}</Button>
      </div>
    </form>
  </Modal>;
}
