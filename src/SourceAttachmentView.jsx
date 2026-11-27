import { useLanguage } from "./preferences";
import React, { useEffect, useState } from "react";
import { ArrowUp, ChevronRight, File, Folder, LockKeyhole, RefreshCw } from "lucide-react";
import { FilePreviewBody, FilePreviewToolbarControls } from "./FilePreviewView";
import { IconButton, Notice, Spinner } from "./ui";
import { usePanelLoad } from "./WorkspaceViews";

export function SourceAttachmentView({ chatId, attachmentId, title, invoke }) {
  return <AttachmentContents key={chatId + "/" + attachmentId}
    chatId={chatId} attachmentId={attachmentId} title={title} invoke={invoke} />;
}

function AttachmentContents({ chatId, attachmentId, title, invoke }) {
  const tr = useLanguage();
  const [trail, setTrail] = useState([]);
  const [viewMode, setViewMode] = useState("preview");
  const [zoom, setZoom] = useState(1);
  const path = trail.at(-1) || "";
  useEffect(() => {
    setViewMode("preview");
    setZoom(1);
  }, [path]);
  const load = usePanelLoad(() => invoke("attachmentPreview", { chatId, attachmentId, path }),
    [chatId, attachmentId, path, invoke]);
  const preview = load.data;
  const label = [title, path].filter(Boolean).join(" / ");
  const isFile = preview?.kind === "file";
  return <>
    <div className="wp-tools">
      {trail.length > 0 && <IconButton icon={ArrowUp} label={tr("返回上一级附件目录", "Parent attachment directory")}
        onClick={() => setTrail(previous => previous.slice(0, -1))} />}
      <span className="wp-tool-title" title={label}>{label}</span>
      {isFile && (
        <FilePreviewToolbarControls
          file={preview}
          viewMode={viewMode}
          setViewMode={setViewMode}
          zoom={zoom}
          setZoom={setZoom}
        />
      )}
      <LockKeyhole size={13} aria-label={tr("只读快照", "Read-only snapshot")} />
      {load.error && <IconButton icon={RefreshCw} label={tr("重新读取附件", "Reload attachment")} onClick={load.reload} />}
    </div>
    <div className={`wp-scroll ${isFile ? "fp-flush-scroll" : ""}`}>
      {load.busy && <div className="wp-empty" role="status"><Spinner /> {tr("正在读取附件…", "Loading attachment…")}</div>}
      {load.error && <Notice>{load.error}</Notice>}
      {preview?.kind === "folder" && <>
        {preview.entries.map(entry => {
          const folder = entry.kind === "directory";
          const Icon = folder ? Folder : File;
          return <button type="button" className="wp-list-row" key={entry.path}
            onClick={() => setTrail(previous => [...previous, entry.path])}>
            <Icon size={16} /><span>{entry.name}</span>{folder && <ChevronRight size={13} />}
          </button>;
        })}
        {!preview.entries.length && <p className="wp-empty">{tr("此文件夹为空", "This folder is empty")}</p>}
      </>}
      {isFile && (
        <FilePreviewBody
          file={preview}
          viewMode={viewMode}
          zoom={zoom}
        />
      )}
    </div>
  </>;
}
