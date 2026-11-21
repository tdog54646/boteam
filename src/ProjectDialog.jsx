import React, { useEffect, useRef, useState } from "react";
import { Folder, FolderPlus, X } from "lucide-react";
import { Button, Field, IconButton, Modal, Notice, errorText } from "./ui";
import "./project-sidebar.css";

export function folderName(path) {
  return path.split(/[/\\]/).filter(Boolean).at(-1) || path;
}

export function ProjectDialog({ project, initialFolder, initialChat, confirmRemoval = false, invoke, onDone, onClose }) {
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
    <Modal title={removing ? "移除本地项目" : project ? "编辑项目" : "导入本地项目"} onClose={cancel}>
      <form onSubmit={save}>
        {removing ? <p className="project-remove-message">从侧栏移除「{project.name}」？聊天会保留在工作台中，磁盘上的文件夹也会保留。</p> : <>
          <label className="project-name-field">
            <span><Folder size={18} /></span>
            <input ref={nameInput} autoComplete="off" data-autofocus aria-label="项目名称" placeholder="项目名称" value={name}
              onChange={e => setName(e.target.value)} disabled={busy} />
          </label>
          <div className="project-folder-heading" id="project-source-heading">源文件夹</div>
          <div className="project-folder-list" role="group" aria-labelledby="project-source-heading">
            {folders.map((folder, index) => <div key={folder} className="project-folder-item">
              <Folder size={16} /><span title={folder}>{folderName(folder)}</span>
              {folders.length > 1 && (index === 0 ? <small className="project-primary-label">主要</small> : <button type="button" disabled={busy} className="project-primary-button" aria-label={`将 ${folderName(folder)} 设为主要`}
                onClick={() => setFolders([folder, ...folders.filter(path => path !== folder)])}>设为主要</button>)}
              <IconButton label={`移除文件夹 ${folderName(folder)}`} icon={X} disabled={busy} onClick={() => setFolders(folders.filter(path => path !== folder))}/>
            </div>)}
            <button type="button" className="project-folder-add" disabled={busy} onClick={addFolder}><FolderPlus size={16}/>添加文件夹</button>
          </div>
        </>}
        <Notice>{error}</Notice>
        <footer className="project-dialog-footer">
          {project && !removing && <Button className="project-remove" disabled={busy} onClick={() => { setRemoving(true); setError(""); }}>移除本地项目</Button>}
          <Button ref={cancelButton} className="project-cancel" disabled={busy} onClick={cancel}>取消</Button>
          <Button type="submit" variant={removing ? "danger" : "primary"} busy={busy} disabled={!removing && (!folders.length || !name.trim())}>{removing ? "移除" : project ? "保存" : "导入"}</Button>
        </footer>
      </form>
    </Modal>
  </div>;
}

export function ProjectActionDialog({ action, project, expectedChatIds, invoke, onDone, onClose }) {
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
  return <Modal title={section ? "新建分区" : "归档聊天"} onClose={() => { if (!pending.current) onClose(); }}>
    <form onSubmit={submit}>
      {section ? <Field label="分区名称"><input data-autofocus type="text" value={name} required maxLength={120}
        onChange={event => setName(event.target.value)} disabled={busy}/></Field>
        : <p className="project-remove-message">将「{project.name}」中的 {expectedChatIds.length} 个聊天归档？你可以在「已归档」中恢复聊天。</p>}
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button data-autofocus={section ? undefined : true} disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={section ? !name.trim() : !expectedChatIds.length}>{section ? "创建并移入" : "归档"}</Button>
      </div>
    </form>
  </Modal>;
}
