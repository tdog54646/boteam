import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronRight,
  File, FilePlus2, Folder, GitBranch, RefreshCw, X,
} from "lucide-react";
import { FilePreviewBody, FilePreviewToolbarControls } from "./FilePreviewView";
import { FileCategoryGlyph } from "./MarkdownContent";
import { Button, errorText, IconButton, Notice, Spinner } from "./ui";

export function usePanelLoad(load, deps) {
  const [result, setResult] = useState({ busy: true });
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((value) => value + 1);
  useEffect(() => {
    let current = true;
    setResult({ busy: true });
    Promise.resolve().then(load).then(
      (data) => { if (current) setResult({ data }); },
      (err) => { if (current) setResult({ error: errorText(err) }); },
    );
    return () => { current = false; };
  }, [...deps, version]);
  return { ...result, reload };
}

function Loading({ load }) {
  if (load.error) return <Notice>{load.error}</Notice>;
  if (load.busy) return <div className="wp-empty" role="status"><Spinner /> 正在读取…</div>;
  return null;
}

export function FilesView({ initialPath = "", call, open }) {
  const [path, setPath] = useState(initialPath);
  const load = usePanelLoad(() => call("panelFiles", { path }), [call, path]);
  const parent = path.split("/").slice(0, -1).join("/");
  return <>
    <div className="wp-tools">
      <IconButton icon={ArrowUp} label="上一级目录" disabled={!path} onClick={() => setPath(parent)} />
      <span className="wp-tool-title" title={load.data?.root}>
        {path || load.data?.root?.split(/[\\/]/).filter(Boolean).at(-1) || "工作目录"}
      </span>
      <IconButton icon={FilePlus2} label="在此目录新建页面" onClick={() => open({ type: "page", directory: path })} />
      <IconButton icon={RefreshCw} label="刷新文件" onClick={load.reload} />
    </div>
    <div className="wp-scroll">
      <Loading load={load} />
      {load.data?.entries.map((entry) => {
        const directory = entry.kind === "directory";
        const Icon = directory ? Folder : File;
        return <button className="wp-list-row" key={entry.path}
          onClick={() => directory ? setPath(entry.path) : open({ type: "file", path: entry.path })}>
          <Icon size={16} /><span>{entry.name}</span>{directory && <ChevronRight size={13} />}
        </button>;
      })}
      {load.data && !load.data.entries.length && <p className="wp-empty">此目录为空</p>}
      {load.data?.truncated && <p className="wp-empty">仅显示部分文件，可按名称搜索。</p>}
    </div>
  </>;
}

function DiffView({ path, call, version }) {
  const load = usePanelLoad(() => call("panelDiff", { path }), [call, path, version]);
  return <div className="wp-diff">
    <Loading load={load} />
    {load.data?.diff ? <pre>{load.data.diff.split("\n").map((line, index) =>
      <span key={index} className={
        line.startsWith("@@") ? "wp-hunk" :
        line.startsWith("+") ? "wp-add" :
        line.startsWith("-") ? "wp-remove" : undefined
      }>{line}{"\n"}</span>)}</pre> :
      load.data && <p className="wp-empty">没有可显示的文本差异</p>}
    {load.data?.truncated && <p className="wp-empty">差异内容已截断。</p>}
  </div>;
}

export function ChangesView({ call, active }) {
  const load = usePanelLoad(() => active ? call("panelChanges") : null, [call, active]);
  const [selected, setSelected] = useState("");
  return <>
    <div className="wp-tools">
      <GitBranch size={15} />
      <strong className="wp-tool-title" title={load.data?.root}>
        {load.data?.branch || "工作区变更"}
      </strong>
      {load.data?.repo && <span className="wp-stats">
        <span>+{load.data.added}</span> <span>−{load.data.removed}</span>
      </span>}
      <IconButton icon={RefreshCw} label="刷新变更" onClick={load.reload} />
    </div>
    <div className="wp-scroll">
      <Loading load={load} />
      {load.data && !load.data.repo && <p className="wp-empty">当前工作目录不在 Git 仓库中。</p>}
      {load.data?.repo && !load.data.files.length && <p className="wp-empty"><Check size={16} /> 工作区没有变更</p>}
      {load.data?.files.map((file) => <React.Fragment key={file.path}>
        <button className="wp-list-row" aria-expanded={selected === file.path}
          onClick={() => setSelected(selected === file.path ? "" : file.path)}>
          <ChevronRight size={14} className={selected === file.path ? "wp-turned" : ""} />
          <span title={file.path}>{file.path}</span>
          <code>{file.status}</code>
          <span className="wp-stats"><span>+{file.added}</span> <span>−{file.removed}</span></span>
        </button>
        {selected === file.path && <DiffView path={file.path} call={call} version={load.data} />}
      </React.Fragment>)}
    </div>
  </>;
}

function Editor({ file, draft, directory, call, onSaved, onDraft, onCancel }) {
  const [name, setName] = useState(draft?.name ?? file?.path ?? "");
  const [content, setContent] = useState(draft?.content ?? file?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  function change(nextName, nextContent) {
    setName(nextName);
    setContent(nextContent);
    const dirty = file ? file.content !== nextContent : Boolean(nextName || nextContent);
    onDraft(dirty ? { name: nextName, content: nextContent, file } : null);
  }
  async function save() {
    if (pending.current) return;
    const filename = name.trim() || "未命名页面";
    const path = file?.path || [directory, /\.md$/i.test(filename) ? filename : filename + ".md"].filter(Boolean).join("/");
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await call("panelSave", { path, content, revision: file?.revision });
      onDraft(null);
      onSaved(saved.path);
    } catch (err) {
      setError(errorText(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <div className="wp-editor" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  }}>
    <div className="wp-tools">
      <File size={15} />
      <span className="wp-tool-title" title={file?.path || directory}>
        {file?.path || (directory ? directory + "/" : "新建页面")}
      </span>
      {file && <IconButton icon={X} label="取消编辑" disabled={busy} onClick={onCancel} />}
      <Button icon={ArrowDownToLine} busy={busy} onClick={save}>保存</Button>
    </div>
    <Notice>{error}</Notice>
    {!file && <input className="wp-page-name" aria-label="页面名称" placeholder="未命名页面"
      value={name} disabled={busy} onChange={(event) => change(event.target.value, content)} />}
    <textarea className="wp-page-content" spellCheck={false} aria-label="页面内容" placeholder="开始编写…"
      value={content} disabled={busy} onChange={(event) => change(name, event.target.value)} />
  </div>;
}

function resolveRelativePreviewPath(baseFilePath, targetPath, resolvedDir) {
  if (!targetPath) return "";
  if (targetPath.startsWith("/")) return targetPath;
  if (resolvedDir) {
    const dirParts = String(resolvedDir).split("/").filter(Boolean);
    for (const seg of String(targetPath).split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") dirParts.pop();
      else dirParts.push(seg);
    }
    return "/" + dirParts.join("/");
  }
  const baseParts = String(baseFilePath || "").split("/").slice(0, -1).filter(Boolean);
  for (const seg of String(targetPath).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join("/");
}

export function DocumentView({ tab, call, open, onSaved, onDraft }) {
  const [edit, setEdit] = useState(tab.type === "file" && Boolean(tab.draft));
  const [viewMode, setViewMode] = useState(() => (tab.line != null ? "source" : "preview"));
  const [zoom, setZoom] = useState(1);
  const load = usePanelLoad(
    () =>
      tab.path
        ? call("panelRead", {
            path: tab.path,
            allowWorkspaceAbsolute: Boolean(tab.allowWorkspaceAbsolute),
          })
        : null,
    [call, tab.path, tab.allowWorkspaceAbsolute],
  );
  useEffect(() => {
    setZoom(1);
    setViewMode(tab.line != null ? "source" : "preview");
  }, [tab.path]);
  useEffect(() => {
    if (tab.line != null) setViewMode("source");
  }, [tab.line, tab.endLine, tab.jumpSeq]);

  const original = tab.draft?.file || load.data;
  if (tab.type === "page" || (edit && original)) {
    return <Editor file={tab.type === "page" ? null : original} draft={tab.draft} directory={tab.directory}
      call={call} onDraft={onDraft} onCancel={() => { onDraft(null); setEdit(false); }}
      onSaved={(path) => { setEdit(false); if (tab.path === path) load.reload(); onSaved(path); }} />;
  }
  const file = load.data;
  const displayTitle = file?.path || tab.path;
  const canEdit = Boolean(file && !file.binary && !file.truncated && file.editable && file.revision != null);
  const revealFile = tab.path ? () => call("panelReveal", { path: tab.path }).catch(() => {}) : undefined;

  return <>
    <div className="wp-tools">
      <FileCategoryGlyph filePath={displayTitle} size={15} />
      <span className="wp-tool-title" title={displayTitle}>{displayTitle}</span>
      <FilePreviewToolbarControls
        file={file}
        viewMode={viewMode}
        setViewMode={setViewMode}
        zoom={zoom}
        setZoom={setZoom}
        canEdit={canEdit}
        onEdit={() => setEdit(true)}
        onReload={load.reload}
        onReveal={file ? revealFile : undefined}
      />
    </div>
    <div className={`wp-scroll ${file ? "fp-flush-scroll" : ""}`}>
      <Loading load={load} />
      {file && (
        <FilePreviewBody
          file={file}
          viewMode={viewMode}
          zoom={zoom}
          line={tab.line}
          endLine={tab.endLine}
          scrollTrigger={tab.jumpSeq}
          onReveal={revealFile}
          onOpenUrl={(url) => open?.({ type: "url", url })}
          onOpenFile={(ref) => {
            const nextPath = resolveRelativePreviewPath(
              file.path || tab.path,
              ref.path,
              file.resolvedDir,
            );
            if (nextPath) {
              open?.({
                type: "file",
                path: nextPath,
                line: ref.line,
                endLine: ref.endLine,
                allowWorkspaceAbsolute: true,
              });
            }
          }}
        />
      )}
    </div>
  </>;
}

export function webAddress(value) {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw);
  if (!/^https?:\/\//i.test(raw) && !local && !/^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : (local ? "http://" : "https://") + raw);
    return !url.username && !url.password && ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function BrowserView({ url, onNavigate, setTitle }) {
  const guest = useRef(null);
  const [address, setAddress] = useState(url);
  const [error, setError] = useState("");
  const [controls, setControls] = useState({ back: false, forward: false, ready: false });
  useEffect(() => {
    const node = guest.current;
    const titles = (event) => { if (event.title) setTitle(event.title); };
    const ready = () => setControls({ back: node.canGoBack(), forward: node.canGoForward(), ready: true });
    const nav = (event) => {
      if (event.isMainFrame === false) return;
      const location = event.url || node.getURL() || url;
      setError("");
      setAddress(location);
      onNavigate(location);
      ready();
    };
    const failed = (event) => {
      if (event.isMainFrame && event.errorCode !== -3) setError(event.errorDescription || "无法打开网页。");
    };
    const events = [["dom-ready", ready], ["did-navigate", nav], ["did-navigate-in-page", nav],
      ["did-fail-load", failed], ["page-title-updated", titles]];
    for (const [name, handler] of events) node.addEventListener(name, handler);
    return () => { for (const [name, handler] of events) node.removeEventListener(name, handler); };
  }, [url, onNavigate, setTitle]);
  async function navigate(event) {
    event.preventDefault();
    const next = webAddress(address);
    if (!next) { setError("请输入 HTTP 或 HTTPS 网址。"); return; }
    setError("");
    try { await guest.current.loadURL(next); }
    catch (err) { setError(errorText(err)); }
  }
  return <div className="wp-browser">
    <form className="wp-tools" onSubmit={navigate}>
      <IconButton icon={ArrowLeft} label="网页后退" disabled={!controls.back} onClick={() => guest.current.goBack()} />
      <IconButton icon={ArrowRight} label="网页前进" disabled={!controls.forward} onClick={() => guest.current.goForward()} />
      <input aria-label="网页地址" className="wp-address" value={address} onChange={(event) => setAddress(event.target.value)} />
      <IconButton icon={RefreshCw} label="刷新网页" disabled={!controls.ready} onClick={() => guest.current.reload()} />
    </form>
    <Notice>{error}</Notice>
    <webview ref={guest} partition="boteam-panel-web" src={url} />
  </div>;
}
