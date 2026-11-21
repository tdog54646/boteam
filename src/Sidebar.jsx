import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, Bot, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Folder, FolderOpen,
  FolderPlus, House, ListFilter, MessageSquare, PanelLeftClose, Pin, PinOff, Search,
  Settings, SlidersHorizontal, SquarePen, UsersRound, WalletCards,
} from "lucide-react";
import { IconButton, Notice, accountLabel, errorText, identityLabel, providerName } from "./ui";
import { ChatRows, MenuItem, SidebarPopup, SidebarSection, shortDate } from "./SidebarParts";
import { ProjectMenu } from "./ProjectMenu";
import "./project-sidebar.css";

const preferenceKey = "boteam.sidebar.preferences.v1";
function preferences() {
  try { return JSON.parse(localStorage.getItem(preferenceKey)) || {}; }
  catch { return {}; }
}
const navigation = [[House, "首页", "home"], [Bot, "Bot 管理", "bots"], [WalletCards, "账号管理", "accounts"]];
const filters = [["all", "全部"], ["unread", "未读"], ["running", "进行中"]];

export function Sidebar({ state, page, select, open, disabled, collapse, history, onChatMenu, onChatAction,
  menuChatId, invoke, refresh, onNewChat, homeBot, onSelectBot, dialogOpen }) {
  const [prefs, setPrefs] = useState(preferences);
  const [popup, setPopup] = useState(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const timer = useRef();
  const projects = disabled ? [] : (state.projects || []);
  const bots = state.bots.filter(bot => !bot.archived);
  const chats = state.chats;
  const runningIds = useMemo(() => new Set(state.tasks
    .filter(task => ["running", "approval", "queued"].includes(task.status))
    .map(task => task.chatId)), [state.tasks]);
  const project = popup?.projectId && projects.find(p => p.id === popup.projectId);
  const sections = state.chatSections || [];
  const filter = prefs.filter || "all";
  const grouped = prefs.grouped !== false;
  const recentArchived = prefs.recentArchived === true;
  const active = disabled ? [] : chats.filter(c => !c.archived);
  const matches = c => filter === "all" || (filter === "unread" ? c.unread : runningIds.has(c.id));
  const pinned = active.filter(c => c.pinned && matches(c));
  const regular = active.filter(c => !c.pinned && matches(c));
  const archived = disabled ? [] : chats.filter(c => c.archived && matches(c));
  const projectIds = new Set(projects.map(p => p.id));
  const sectionIds = new Set(sections.map(s => s.id));
  const free = regular.filter(c => !sectionIds.has(c.sectionId));
  const recent = (recentArchived ? archived : free.filter(c => !grouped || prefs.recentProjects || !projectIds.has(c.projectId)))
    .slice().sort((a, b) => prefs.sort === "created" ? b.creationOrder - a.creationOrder : b.updatedAt.localeCompare(a.updatedAt));
  const rowProps = { selected: page, select, runningIds, onChatAction, menuChatId, onChatMenu: (...args) => { dismiss(); onChatMenu(...args); } };
  useEffect(() => {
    const changed = e => { if (e.key === preferenceKey) setPrefs(preferences()); };
    window.addEventListener("storage", changed);
    return () => { clearTimeout(timer.current); window.removeEventListener("storage", changed); };
  }, []);
  useEffect(() => {
    clearTimeout(timer.current);
    setPopup(null);
  }, [page]);
  useEffect(() => {
    const anchor = popup?.type === "projectMenu" ? popup.anchor.anchor : popup?.anchor;
    if (dialogOpen || (popup && !anchor?.isConnected)) {
      clearTimeout(timer.current);
      setPopup(null);
    }
  }, [dialogOpen, popup, projects, prefs]);
  function update(changes) {
    const next = { ...preferences(), ...changes };
    setPrefs(next);
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch {}
  }
  function disclosure(key, initial = true) {
    const expanded = prefs.folded?.[key] === undefined ? initial : !prefs.folded[key];
    return { expanded, toggle: () => update({ folded: { ...preferences().folded, [key]: expanded } }) };
  }
  function dismiss() { clearTimeout(timer.current); setPopup(null); }
  function show(event, type) {
    clearTimeout(timer.current);
    setPopup(popup?.type === type ? null : { type, anchor: event.currentTarget, keyboard: event.detail === 0 });
  }
  function choose(fn) {
    if (popup?.keyboard) (popup.trigger || popup.anchor)?.focus({ preventScroll: true });
    dismiss(); fn();
  }
  function delayClose() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPopup(current => current?.type === "project" ? null : current), 180);
  }
  function hoverProject(anchor, projectId) {
    clearTimeout(timer.current);
    if (dialogOpen || (popup && popup.type !== "project")) return;
    timer.current = setTimeout(() => {
      if (anchor.isConnected) setPopup({ type: "project", projectId, anchor });
    }, 420);
  }
  function openProjectMenu(projectId, trigger, point) {
    clearTimeout(timer.current);
    const rect = trigger.getBoundingClientRect();
    setPopup({ type: "projectMenu", projectId, anchor: { anchor: trigger, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom + 4 } });
  }
  async function importProject() {
    if (picking || disabled) return;
    dismiss(); setPicking(true); setError("");
    try {
      const folder = await invoke("pickDirectory");
      if (folder) open({ type: "project", initialFolder: folder });
    } catch (e) { setError(errorText(e)); }
    finally { setPicking(false); }
  }
  async function updateProject(method, args) {
    try { setError(""); await invoke(method, args); await refresh(); }
    catch (e) { setError(errorText(e)); }
  }
  function projectRows(list) {
    return list.map(p => {
      const tree = disclosure("project:" + p.id);
      const children = free.filter(c => c.projectId === p.id);
      const FolderIcon = tree.expanded && children.length ? FolderOpen : Folder;
      const showing = project?.id === p.id;
      const menuOpen = showing && popup.type === "projectMenu";
      function context(event, keyboard) {
        event.preventDefault();
        const trigger = event.currentTarget.querySelector(".project-toggle");
        openProjectMenu(p.id, trigger, keyboard ? undefined : { x: event.clientX, y: event.clientY });
      }
      return <div key={p.id} className="sidebar-project" data-project-id={p.id}>
        <div className={`sidebar-project-row ${showing ? "showing" : ""}`} onPointerEnter={e => {
          if (e.pointerType !== "touch") hoverProject(e.currentTarget, p.id);
        }} onPointerLeave={delayClose} onContextMenu={e => context(e, false)} onKeyDown={e => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) context(e, true);
        }}>
          <button className="rail-row project-toggle" title={p.name} aria-expanded={tree.expanded}
            onClick={() => { dismiss(); tree.toggle(); }}><FolderIcon/><span>{p.name}</span></button>
          <div className="project-row-tools">
            <IconButton icon={Ellipsis} label={p.name + " 的项目操作"} aria-expanded={menuOpen} aria-haspopup="menu"
              onClick={e => {
                if (menuOpen) dismiss();
                else openProjectMenu(p.id, e.currentTarget);
              }}/>
            <IconButton icon={SquarePen} label={"在 " + p.name + " 中新建聊天"} onClick={() => choose(() => onNewChat(p.id))}/>
          </div>
        </div>
        {tree.expanded && children.length > 0 && <div className="project-chats"><ChatRows {...rowProps} chats={children}/></div>}
      </div>;
    });
  }

  return <aside className="sidebar project-sidebar" aria-label="侧栏" onKeyDown={e => {
    if (e.key === "ArrowDown" && e.target.matches('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]') && (!popup || popup.type === "project")) {
      e.preventDefault(); e.target.click();
    }
  }}>
    <div className="sidebar-titlebar">
      <IconButton label="收起侧栏" icon={PanelLeftClose} onClick={collapse}/>
      <IconButton label="后退" icon={ChevronLeft} disabled={!history.back || disabled} onClick={() => history.move(-1)}/>
      <IconButton label="前进" icon={ChevronRight} disabled={!history.forward || disabled} onClick={() => history.move(1)}/>
    </div>
    <nav className="rail-primary" aria-label="工作台">
      <div className="workbench-heading">
        <button className="workbench-switch" aria-label="切换工作台" aria-haspopup="menu" aria-expanded={popup?.type === "workbench"}
          disabled={disabled} onClick={e => show(e, "workbench")}>BoTeam <ChevronDown size={14}/></button>
        <IconButton label="整理侧边栏" icon={ListFilter} aria-haspopup="menu" aria-expanded={popup?.type === "layout"}
          className={filter !== "all" || !grouped ? "option-active" : ""} disabled={disabled} onClick={e => show(e, "layout")}/>
        <IconButton label="搜索对话" icon={Search} disabled={disabled} onClick={() => choose(() => open({ type: "search" }))}/>
      </div>
      <button className="rail-row" aria-label="新建对话" disabled={disabled} onClick={() => choose(() => onNewChat())}>
        <SquarePen/><span>新建对话</span><kbd>⌘ N</kbd>
      </button>
      {homeBot && <button type="button" className="rail-row sidebar-quick-bot" aria-label="选择默认 Bot"
        aria-description={`当前 Bot 为 ${homeBot.name}`} title={`选择默认 Bot · ${homeBot.name}`}
        disabled={disabled} aria-haspopup="menu" aria-expanded={popup?.type === "bot"}
        onClick={e => show(e, "bot")}>
        <Bot className="quick-bot-icon" size={16} aria-hidden="true"/><span>{homeBot.name}</span><ChevronDown className="sidebar-bot-chevron"/>
      </button>}
    </nav>
    <nav className="rail-history" aria-label="聊天列表">
      {(pinned.length > 0 || (grouped && projects.some(p => p.pinned))) && <SidebarSection title="置顶" {...disclosure("pinned")}>
        <ChatRows {...rowProps} chats={pinned}/>{grouped && projectRows(projects.filter(p => p.pinned))}
      </SidebarSection>}
      {sections.map(s => <SidebarSection key={s.id} title={s.name} {...disclosure("section:" + s.id)}>
        <ChatRows {...rowProps} chats={regular.filter(c => c.sectionId === s.id)}/>
        {grouped && projectRows(projects.filter(p => !p.pinned && p.sectionId === s.id))}
      </SidebarSection>)}
      {grouped && <SidebarSection title="项目" {...disclosure("projects")} actions={
        <IconButton icon={FolderPlus} label="导入本地项目" className="project-import" disabled={disabled || picking} onClick={importProject}/>}>
        {projectRows(projects.filter(p => !p.pinned && !sectionIds.has(p.sectionId)))}
      </SidebarSection>}
      <SidebarSection title="最近" {...disclosure("recent")} actions={<>
        <IconButton label="最近聊天选项" icon={SlidersHorizontal} aria-haspopup="menu" aria-expanded={popup?.type === "recent"}
          className={recentArchived || prefs.recentProjects || prefs.sort === "created" ? "option-active" : ""} disabled={disabled} onClick={e => show(e, "recent")}/>
        <IconButton label="开始新聊天" icon={SquarePen} disabled={disabled} onClick={() => choose(() => onNewChat())}/>
      </>}>
        <ChatRows {...rowProps} chats={recent}/>
        {!recent.length && !disabled && <div className="rail-empty">{filter !== "all" ? "没有匹配的聊天" : recentArchived ? "暂无已归档聊天" : "暂无聊天"}</div>}
      </SidebarSection>
      {archived.length > 0 && !recentArchived && <SidebarSection title="已归档" {...disclosure("archived", false)}>
        <ChatRows {...rowProps} chats={archived}/>
      </SidebarSection>}
    </nav>
    <Notice>{error}</Notice>
    <nav className="rail-settings" aria-label="管理">
      {navigation.slice(1).map(([Icon, label, id]) => <button key={id} className="rail-row" disabled={disabled}
        aria-current={page === id && !disabled ? "page" : undefined} onClick={() => choose(() => select(id))}><Icon/><span>{label}</span></button>)}
    </nav>
    {popup?.type === "workbench" && <SidebarPopup popup={popup} close={dismiss} title="切换工作台">
      {navigation.map(([Icon, label, id]) => <MenuItem key={id} icon={Icon} checked={page === id || (id === "home" && !["bots","accounts"].includes(page))}
        onClick={() => choose(() => select(id))}>{label}</MenuItem>)}
      <hr/><MenuItem icon={FolderPlus} onClick={importProject}>导入本地项目</MenuItem>
    </SidebarPopup>}
    {popup?.type === "bot" && homeBot && <SidebarPopup popup={popup} close={dismiss} title="选择默认 Bot">
      {bots.map(bot => {
        const account = state.accounts.find(a => a.id === bot.accountId);
        const duplicate = bots.some(other => other.id !== bot.id && bot.name === other.name);
        const detail = [providerName(account?.provider), accountLabel(account), account?.note && identityLabel(account)].filter(Boolean).join(" · ");
        return <MenuItem key={bot.id} icon={Bot} radio checked={bot.id === homeBot.id}
          label={duplicate ? bot.name + " · " + detail : bot.name} detail={detail}
          onClick={() => choose(() => onSelectBot(bot.id))}>{bot.name}</MenuItem>;
      })}
    </SidebarPopup>}
    {popup?.type === "layout" && <SidebarPopup popup={popup} close={dismiss} title="整理侧边栏">
      <div className="sidebar-menu-caption">整理侧边栏</div>
      {[[true, "分项目显示"], [false, "合并显示"]].map(([value,label]) => <MenuItem key={label} checked={grouped === value}
        onClick={() => choose(() => update({ grouped: value }))}>{label}</MenuItem>)}
      <hr/><div className="sidebar-menu-caption">筛选条件</div>
      {filters.map(([value,label]) => <MenuItem key={value} checked={filter === value} onClick={() => choose(() => update({ filter: value }))}>{label}</MenuItem>)}
    </SidebarPopup>}
    {popup?.type === "recent" && <SidebarPopup popup={popup} close={dismiss} title="最近聊天选项">
      <div className="sidebar-menu-caption">筛选条件</div>
      {[[false, "未归档"], [true, "已归档"]].map(([value,label]) => <MenuItem key={label} checked={recentArchived === value}
        onClick={() => choose(() => update({ recentArchived: value }))}>{label}</MenuItem>)}
      {grouped && <><hr/><div className="sidebar-menu-caption">显示</div><MenuItem checked={Boolean(prefs.recentProjects)} onClick={() => choose(() => update({ recentProjects: !prefs.recentProjects }))}>项目中的聊天</MenuItem></>}
      <hr/><div className="sidebar-menu-caption">排序方式</div>
      {[["updated","最近更新"],["created","创建时间"]].map(([value,label]) => <MenuItem key={value} checked={(prefs.sort || "updated") === value}
        onClick={() => choose(() => update({ sort: value }))}>{label}</MenuItem>)}
    </SidebarPopup>}
    {project && popup.type === "projectMenu" && <ProjectMenu project={project} sections={sections} chats={chats}
      anchor={popup.anchor} onClose={dismiss} open={open} invokeAction={updateProject}/>}
    {project && popup.type === "project" && <SidebarPopup popup={popup} close={dismiss} title={project.name + " 项目详情"} card
      onEnter={() => clearTimeout(timer.current)} onLeave={delayClose}>
      <header><Folder size={16}/><strong>{project.name}</strong>
        <IconButton label={project.pinned ? "取消置顶项目" : "置顶项目"} icon={project.pinned ? PinOff : Pin}
          onClick={() => choose(() => updateProject("setProjectPinned", { projectId: project.id, pinned: !project.pinned }))}/></header>
      <div className="project-chat-count"><MessageSquare size={15}/><span>{active.filter(c => c.projectId === project.id).length} 次聊天</span></div>
      {project.folders.length > 0 && <div className="project-card-folders">
        {project.folders.map(folder => <button key={folder} type="button" title={folder}
          onClick={() => choose(() => updateProject("openProjectFolder", {projectId: project.id, folder}))}><Folder size={15}/><span dir="rtl"><bdi dir="ltr">{folder}</bdi></span></button>)}
      </div>}
      <button type="button" className="project-edit" onClick={() => choose(() => open({ type: "project", id: project.id }))}><Settings size={15}/>编辑项目</button>
    </SidebarPopup>}
  </aside>;
}
export function ChatSearch({ state, select }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const projects = state.projects || [];
  const projectNames = new Map(projects.map(p => [p.id, p.name]));
  const matchedProjects = new Set(projects.filter(p => [p.name, ...p.folders].some(value => value.toLocaleLowerCase().includes(term))).map(p => p.id));
  const matchedMessages = new Set(term ? state.messages.filter(m => m.text?.toLocaleLowerCase().includes(term)).map(m => m.chatId) : []);
  const results = state.chats.filter(chat => !term || chat.name.toLocaleLowerCase().includes(term)
    || matchedProjects.has(chat.projectId) || matchedMessages.has(chat.id));
  return (
    <div className="quick-search">
      <label className="quick-search-input">
        <Search size={16} />
        <input
          data-autofocus
          type="search"
          aria-label="搜索会话名称或消息"
          placeholder="搜索聊天、消息、项目或文件夹"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="search-results">
        {results.map((chat) => {
          const Icon = chat.kind === "group" ? UsersRound : MessageSquare;
          return (
            <button key={chat.id} onClick={() => select(chat.id)}>
              <Icon size={16} />
              <span>{chat.name}</span>
              {projectNames.has(chat.projectId) && <small className="search-result-project">{projectNames.get(chat.projectId)}</small>}
              {chat.archived && <Archive size={13} aria-label="已归档" />}
              <time>{shortDate(chat.updatedAt)}</time>
            </button>
          );
        })}
        {results.length === 0 && (
          <p>{term ? "没有找到匹配的对话" : "暂无对话"}</p>
        )}
      </div>
    </div>
  );
}
