import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Bot, Check, ChevronDown, Ellipsis, File, FileText, Folder, Folders, Globe2,
  LayoutGrid, List, Maximize2, Minimize2, PanelRight, Plus, Search, FileDiff, SquareTerminal, X,
} from "lucide-react";
import { SourceAttachmentView } from "./SourceAttachmentView";
import { SubagentsPanel } from "./Subagents";
import { errorText, IconButton, Spinner } from "./ui";
import {
  BrowserView, ChangesView, DocumentView, FilesView, webAddress,
} from "./WorkspaceViews";
import "./workspace-panel.css";

const TerminalView = lazy(() => import("./WorkspaceTerminal"));

// Keep uncommitted editors available when navigation unmounts a chat or changes its bot.
const draftsByScope = new Map();

const tools = [
  { type: "page", name: "新建页面", icon: FileText },
  { type: "changes", name: "变更", icon: FileDiff },
  { type: "terminal", name: "终端", icon: SquareTerminal },
  { type: "files", name: "文件", icon: Folders },
];
const icons = { home: Plus, file: File, attachment: File, url: Globe2, agents: Bot, ...Object.fromEntries(tools.map((tool) => [tool.type, tool.icon])) };
function tabName(tab) {
  if (tab.type === "agents") return "子智能体";
  return tab.title || tab.path?.split("/").at(-1) || (tab.url && new URL(tab.url).hostname)
    || tools.find((tool) => tool.type === tab.type)?.name || "新标签页";
}
function newTab(details) {
  return { id: crypto.randomUUID(), type: "home", ...details };
}

function Launcher({ call, open }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(() => localStorage.getItem("boteam:panel-list") === "true");
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  const value = query.trim();
  const url = webAddress(value);
  const explicitUrl = /^https?:\/\//i.test(value) && url;
  useEffect(() => {
    if (!value || explicitUrl) return;
    let current = true;
    const timer = setTimeout(() => {
      call("panelSearch", { query: value }).then(
        (data) => { if (current) setResult({ value, entries: data.entries, truncated: data.truncated }); },
        (error) => { if (current) setResult({ value, error: errorText(error) }); },
      );
    }, 140);
    return () => { current = false; clearTimeout(timer); };
  }, [call, value, explicitUrl]);
  useEffect(() => {
    if (!menu) return;
    function outside(event) { if (!menuRef.current?.contains(event.target)) setMenu(false); }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const entries = result?.value === value ? result.entries || [] : [];
  function choose(entry) {
    open({ type: entry.kind === "directory" ? "files" : "file", path: entry.path });
  }
  async function submit(event) {
    event.preventDefault();
    if (!value) return;
    if (explicitUrl) { open({ type: "url", url }); return; }
    let matches = entries;
    if (result?.value !== value) {
      try {
        const data = await call("panelSearch", { query: value });
        matches = data.entries;
      } catch (error) {
        if (inputRef.current?.value.trim() === value) setResult({ value, error: errorText(error) });
      }
      if (inputRef.current?.value.trim() !== value) return;
    }
    const name = value.toLowerCase();
    const exact = matches.find((entry) => entry.path.toLowerCase() === name)
      || matches.find((entry) => entry.name.toLowerCase() === name);
    if (exact) choose(exact);
    else if (url) open({ type: "url", url });
    else if (matches.length) choose(matches[0]);
  }
  return <div className="wp-launcher">
    <div className="wp-launcher-inner">
      <div className="wp-search-area">
        <form className="wp-search" onSubmit={submit}>
          <Search size={16} strokeWidth={1.7} />
          <input ref={inputRef} aria-label="搜索文件或输入网址" placeholder="搜索文件或输入网址" autoComplete="off"
            spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          {query && <IconButton label="清除搜索" icon={X} onClick={() => setQuery("")} />}
        </form>
        {value && <div className="wp-search-results" aria-label="工作区搜索结果">
          {url && <button onClick={() => open({ type: "url", url })}><Globe2 size={14} /><span>打开 {url}</span></button>}
          {!explicitUrl && (result?.value !== value ? <p><Spinner size={14} /> 正在搜索…</p> :
            result.error ? <p role="alert">{result.error}</p> :
            entries.length ? entries.map((entry) =>
              <button key={entry.path} onClick={() => choose(entry)} title={entry.path}>
                {entry.kind === "directory" ? <Folder size={14} /> : <File size={14} />}
                <span>{entry.path}</span>
              </button>) : <p>没有找到相关文件</p>)}
          {!explicitUrl && result?.value === value && result.truncated && <p>可输入更完整的路径缩小范围。</p>}
        </div>}
      </div>
      <div className="wp-launcher-heading">
        <span>打开</span>
        <div className="wp-more" ref={menuRef} onKeyDown={(event) => {
          if (event.key === "Escape") { setMenu(false); menuRef.current.querySelector("button").focus(); }
        }}>
          <IconButton icon={Ellipsis} label="打开选项" aria-expanded={menu} onClick={() => setMenu(!menu)} />
          {menu && <div className="wp-option-menu">
            {[{ value: false, Icon: LayoutGrid, label: "卡片视图" }, { value: true, Icon: List, label: "列表视图" }]
              .map(({value, Icon, label}) => <button key={label} onClick={() => {
                setList(value);
                localStorage.setItem("boteam:panel-list", String(value));
                setMenu(false);
              }}><Icon size={14} />{label}{list === value && <Check size={13} />}</button>)}
          </div>}
        </div>
      </div>
      <div className={`wp-tiles ${list ? "wp-list-mode" : ""}`}>
        {tools.map(({ type, name, icon: Icon }) =>
          <button key={type} onClick={() => open({ type })}>
            <Icon size={16} strokeWidth={1.7} /><span>{name}</span>
          </button>)}
      </div>
    </div>
  </div>;
}

function TabContent({ tab, chatId, initialProjectCwd, active, invoke, bots, agents, openTab, patchTab, draftScope }) {
  const call = useCallback((method, payload) => invoke(method, {
    ...payload, chatId, botId: tab.botId, expectedProjectCwd: initialProjectCwd,
  }), [invoke, chatId, tab.botId, initialProjectCwd]);
  const setTitle = useCallback((title) => patchTab(tab.id, { title }), [tab.id, patchTab]);
  const onNavigate = useCallback((location) => patchTab(tab.id, { location }), [tab.id, patchTab]);
  function onDraft(draft) {
    if (draft) {
      const saved = draftsByScope.get(draftScope) || new Map();
      saved.set(tab.id, { ...tab, draft, dirty: true });
      draftsByScope.set(draftScope, saved);
    } else {
      const saved = draftsByScope.get(draftScope);
      saved?.delete(tab.id);
      if (!saved?.size) draftsByScope.delete(draftScope);
    }
    if (Boolean(draft) !== Boolean(tab.dirty)) patchTab(tab.id, { dirty: Boolean(draft), draft: undefined });
  }
  const open = (details) => openTab({ botId: tab.botId, ...details }, tab.type === "home" ? tab.id : null);
  let view;
  switch (tab.type) {
    case "agents": view = <SubagentsPanel agents={agents} agentKey={tab.agentKey} chatId={chatId} invoke={invoke} activeTab={active}
      select={agentKey => patchTab(tab.id, { agentKey })} />; break;
    case "attachment": view = <SourceAttachmentView chatId={chatId} attachmentId={tab.attachmentId}
      title={tab.title} invoke={invoke} />; break;
    case "files": view = <FilesView initialPath={tab.path} call={call} open={open} />; break;
    case "changes": view = <ChangesView active={active} call={call} />; break;
    case "terminal": view = <Suspense fallback={<div className="wp-empty"><Spinner /> 正在打开终端…</div>}>
      <TerminalView active={active} call={call} />
    </Suspense>; break;
    case "file":
    case "page":
      view = <DocumentView tab={tab} call={call} onDraft={onDraft}
        onSaved={(path) => patchTab(tab.id, { type: "file", path, dirty: false })} />; break;
    case "url": view = <BrowserView url={tab.url} onNavigate={onNavigate} setTitle={setTitle} />; break;
    default: view = <Launcher call={call} open={open} />;
  }
  return <section className="wp-tab-body" role="tabpanel" aria-labelledby={"wp-tab-" + tab.id}
    id={"wp-panel-" + tab.id} hidden={!active}>
    {bots.length > 1 && ["home", "files", "changes"].includes(tab.type) &&
      <label className="wp-scope">
        <Folder size={13} />
        <select aria-label="成员工作目录" value={tab.botId || bots[0].id}
          onChange={(event) => openTab({ type: tab.type, botId: event.target.value }, tab.id)}>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} 的工作目录</option>)}
        </select><ChevronDown size={12} />
      </label>}
    {view}
  </section>;
}

export function WorkspacePanel({ chatId, botId, draftScope, initialProjectCwd, bots = [], agents = [], invoke, visible = true, expanded = false,
  onToggleExpanded, onClose, request }) {
  const [tabs, setTabs] = useState(() => {
    const drafts = draftsByScope.get(draftScope);
    return drafts?.size ? [...drafts.values()] : [newTab({ botId })];
  });
  const [selected, select] = useState(tabs[0].id);
  const [discard, setDiscard] = useState(null);
  const openedRequest = useRef(null);
  const patchTab = useCallback((id, change) => {
    setTabs((items) => items.map((item) => item.id === id ? { ...item, ...change } : item));
  }, []);
  function openTab(details, replaceId) {
    const next = newTab({ botId, ...details });
    setTabs((items) => replaceId ? items.map((item) => item.id === replaceId ? next : item) : [...items, next]);
    select(next.id);
    setDiscard(null);
  }
  useEffect(() => {
    if (!visible || !request || request.id === openedRequest.current) return;
    openedRequest.current = request.id;
    const { id, ...details } = request;
    if (details.type === "url") {
      details.url = webAddress(details.url || "");
      if (!details.url) return;
    }
    const current = tabs.find((tab) => tab.id === selected);
    const existing = tabs.find((tab) => tab.type === details.type &&
      (tab.botId || botId) === (details.botId || botId) && tab.path === details.path && (tab.location || tab.url) === details.url &&
      tab.attachmentId === details.attachmentId);
    if (existing) {
      if (details.type === "agents") patchTab(existing.id, { agentKey: details.agentKey });
      select(existing.id);
    }
    else openTab(details, current?.type === "home" ? current.id : null);
  }, [request, visible, selected, tabs, botId]);
  useEffect(() => {
    if (visible) document.getElementById("wp-tab-" + selected)?.parentElement.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, visible]);
  function closeTab(id, confirmed = false) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (tabs[index].dirty && !confirmed) { select(id); setDiscard(id); return; }
    setDiscard(null);
    const drafts = draftsByScope.get(draftScope);
    drafts?.delete(id);
    if (!drafts?.size) draftsByScope.delete(draftScope);
    const rest = tabs.filter((tab) => tab.id !== id);
    if (!rest.length) {
      const home = newTab({ botId });
      setTabs([home]);
      select(home.id);
      onClose();
    } else {
      setTabs(rest);
      if (id === selected) select(rest[Math.min(index, rest.length - 1)].id);
    }
  }
  return <aside className={`workspace-panel ${expanded ? "wp-expanded" : ""}`} aria-label="右侧工作区" hidden={!visible}>
    <header className="wp-header">
      <div className="wp-tabs" role="tablist" aria-label="工作区标签">
        {tabs.map((tab, i) => {
          const name = tabName(tab);
          const Icon = icons[tab.type] || File;
          return <div className={`wp-tab ${selected === tab.id ? "selected" : ""}`} key={tab.id}>
            <button className="wp-tab-select" role="tab" aria-selected={selected === tab.id}
              id={"wp-tab-" + tab.id} aria-controls={"wp-panel-" + tab.id} title={name}
              tabIndex={selected === tab.id ? 0 : -1} onClick={() => select(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "Delete") { event.preventDefault(); closeTab(tab.id); return; }
                const target = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length,
                  Home: 0, End: tabs.length - 1 }[event.key];
                if (target === undefined) return;
                event.preventDefault();
                select(tabs[target].id);
                document.getElementById("wp-tab-" + tabs[target].id)?.focus();
              }}><Icon size={15} /><span>{name}{tab.dirty && " ·"}</span></button>
            <IconButton icon={X} label={"关闭标签页 " + name} onClick={() => closeTab(tab.id)} />
          </div>;
        })}
      </div>
      <IconButton icon={Plus} label="添加标签页" onClick={() => openTab({ type: "home" })} />
      <div className="wp-header-spacer" />
      <IconButton icon={expanded ? Minimize2 : Maximize2} label={expanded ? "恢复侧栏大小" : "展开工作区"}
        onClick={onToggleExpanded} />
      <IconButton icon={PanelRight} label="关闭右侧工作区" className="wp-toggle" onClick={onClose} />
    </header>
    {discard && <div className="wp-discard" role="alert">
      <span>页面有未保存的修改。</span>
      <button onClick={() => setDiscard(null)}>继续编辑</button>
      <button onClick={() => closeTab(discard, true)}>放弃并关闭</button>
    </div>}
    {tabs.map((tab) => <TabContent key={tab.id} tab={tab} chatId={chatId} initialProjectCwd={initialProjectCwd} active={visible && selected === tab.id}
      invoke={invoke} bots={bots} agents={agents} draftScope={draftScope} openTab={openTab} patchTab={patchTab} />)}
  </aside>;
}
