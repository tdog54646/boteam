import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, Ellipsis, Folder, FolderOpen,
  FolderPlus, House, ListFilter, MessageSquare, Pin, PinOff, Search,
  Settings, SlidersHorizontal, SquarePen, UsersRound,
} from "lucide-react";
import { IconButton, Notice, ProviderIcon, accountLabel, errorText, identityLabel, providerName } from "./ui";
import { ChatRows, MenuItem, SidebarPopup, SidebarSection, shortDate } from "./SidebarParts";
import { SidebarTitlebar } from "./WorkspaceNavigation";
import { useLanguage } from "./preferences";
import { ProjectMenu } from "./ProjectMenu";
import { ChatRowTitle } from "./ChatRowTitle";
import "./project-sidebar.css";

const preferenceKey = "boteam.sidebar.preferences.v1";
function preferences() {
  try { return JSON.parse(localStorage.getItem(preferenceKey)) || {}; }
  catch { return {}; }
}


export function Sidebar({ state, page, select, open, disabled, collapse, history, onChatMenu, onChatAction,
  menuChatId, invoke, refresh, onNewChat, homeBot, onSelectBot, dialogOpen }) {
  const t = useLanguage();
  const filters = [["all", t("全部", "All")], ["unread", t("未读", "Unread")], ["running", t("进行中", "Running")]];
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
  const active = disabled ? [] : chats.filter(c => !c.archived);
  const matches = c => filter === "all" || (filter === "unread" ? c.unread : runningIds.has(c.id));
  const pinned = active.filter(c => c.pinned && matches(c));
  const regular = active.filter(c => !c.pinned && matches(c));
  const projectIds = new Set(projects.map(p => p.id));
  const sectionIds = new Set(sections.map(s => s.id));
  const free = regular.filter(c => !sectionIds.has(c.sectionId));
  const recent = free.filter(c => !grouped || prefs.recentProjects || !projectIds.has(c.projectId))
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

  return <aside className="sidebar project-sidebar" aria-label={t("侧栏", "Sidebar")} onKeyDown={e => {
    if (e.key === "ArrowDown" && e.target.matches('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]') && (!popup || popup.type === "project")) {
      e.preventDefault(); e.target.click();
    }
  }}>
    <SidebarTitlebar collapse={collapse} history={history} disabled={disabled}/>
    <nav className="rail-primary" aria-label={t("工作台", "Workspace")}>
      <div className="workbench-heading">
        <button className="workbench-switch" aria-label={t("切换工作台", "Switch workspace")} aria-haspopup="menu" aria-expanded={popup?.type === "workbench"}
          disabled={disabled} onClick={e => show(e, "workbench")}>BoTeam <ChevronDown size={14}/></button>
        <IconButton label={t("整理侧边栏", "Organize sidebar")} icon={ListFilter} aria-haspopup="menu" aria-expanded={popup?.type === "layout"}
          className={filter !== "all" || !grouped ? "option-active" : ""} disabled={disabled} onClick={e => show(e, "layout")}/>
        <IconButton label={t("搜索对话", "Search chats")} icon={Search} disabled={disabled} onClick={() => choose(() => open({ type: "search" }))}/>
      </div>
      <button className="rail-row" aria-label={t("新建对话", "New chat")} disabled={disabled} onClick={() => choose(() => onNewChat())}>
        <SquarePen/><span>{t("新建对话", "New chat")}</span><kbd>⌘ N</kbd>
      </button>
      {homeBot && <button type="button" className="rail-row sidebar-quick-bot" aria-label={t("选择默认 Bot", "Select default bot")}
        aria-description={homeBot.name} title={t("选择默认 Bot", "Select default bot") + " · " + homeBot.name}
        disabled={disabled} aria-haspopup="menu" aria-expanded={popup?.type === "bot"}
        onClick={e => show(e, "bot")}>
        <ProviderIcon provider={state.accounts.find(a => a.id === homeBot.accountId)?.provider} size="small"/>
        <span>{homeBot.name}</span><ChevronDown className="sidebar-bot-chevron"/>
      </button>}
    </nav>
    <nav className="rail-history" aria-label={t("聊天列表", "Chat list")}>
      {(pinned.length > 0 || (grouped && projects.some(p => p.pinned))) && <SidebarSection title={t("置顶", "Pinned")} {...disclosure("pinned")}>
        <ChatRows {...rowProps} chats={pinned}/>{grouped && projectRows(projects.filter(p => p.pinned))}
      </SidebarSection>}
      {sections.map(s => <SidebarSection key={s.id} title={s.name} {...disclosure("section:" + s.id)}>
        <ChatRows {...rowProps} chats={regular.filter(c => c.sectionId === s.id)}/>
        {grouped && projectRows(projects.filter(p => !p.pinned && p.sectionId === s.id))}
      </SidebarSection>)}
      {grouped && <SidebarSection title={t("项目", "Projects")} {...disclosure("projects")} actions={
        <IconButton icon={FolderPlus} label={t("导入本地项目", "Import local project")} className="project-import" disabled={disabled || picking} onClick={importProject}/>}>
        {projectRows(projects.filter(p => !p.pinned && !sectionIds.has(p.sectionId)))}
      </SidebarSection>}
      <SidebarSection title={t("最近", "Recent")} {...disclosure("recent")} actions={<>
        <IconButton label={t("最近聊天选项", "Recent chat options")} icon={SlidersHorizontal} aria-haspopup="menu" aria-expanded={popup?.type === "recent"}
          className={prefs.recentProjects || prefs.sort === "created" ? "option-active" : ""} disabled={disabled} onClick={e => show(e, "recent")}/>
        <IconButton label={t("开始新聊天", "Start new chat")} icon={SquarePen} disabled={disabled} onClick={() => choose(() => onNewChat())}/>
      </>}>
        <ChatRows {...rowProps} chats={recent}/>
        {!recent.length && !disabled && <div className="rail-empty">{filter !== "all" ? t("没有匹配的聊天", "No matching chats") : t("暂无聊天", "No chats yet")}</div>}
      </SidebarSection>
    </nav>
    <Notice>{error}</Notice>
    {popup?.type === "workbench" && <SidebarPopup popup={popup} close={dismiss} title={t("切换工作台", "Switch workspace")}>
      <MenuItem icon={<House size={15}/>} checked={true} onClick={() => choose(() => select("home"))}>{t("首页", "Home")}</MenuItem>
      <hr/><MenuItem icon={<FolderPlus size={15}/>} onClick={importProject}>{t("导入本地项目", "Import local project")}</MenuItem>
    </SidebarPopup>}
    {popup?.type === "bot" && homeBot && <SidebarPopup popup={popup} close={dismiss} title={t("选择默认 Bot", "Select default bot")}>
      {bots.map(bot => {
        const account = state.accounts.find(a => a.id === bot.accountId);
        const duplicate = bots.some(other => other.id !== bot.id && bot.name === other.name);
        const detail = [providerName(account?.provider), accountLabel(account), account?.note && identityLabel(account)].filter(Boolean).join(" · ");
        return <MenuItem key={bot.id} icon={<ProviderIcon provider={account?.provider} size="small"/>} radio checked={bot.id === homeBot.id}
          label={duplicate ? bot.name + " · " + detail : bot.name} detail={detail}
          onClick={() => choose(() => onSelectBot(bot.id))}>{bot.name}</MenuItem>;
      })}
    </SidebarPopup>}
    {popup?.type === "layout" && <SidebarPopup popup={popup} close={dismiss} title={t("整理侧边栏", "Organize sidebar")}>
      <div className="sidebar-menu-caption">{t("整理侧边栏", "Organize sidebar")}</div>
      {[[true, t("分项目显示", "Group by project")], [false, t("合并显示", "Combined list")]].map(([value,label]) => <MenuItem key={label} checked={grouped === value}
        onClick={() => choose(() => update({ grouped: value }))}>{label}</MenuItem>)}
      <hr/><div className="sidebar-menu-caption">{t("筛选条件", "Filter")}</div>
      {filters.map(([value,label]) => <MenuItem key={value} checked={filter === value} onClick={() => choose(() => update({ filter: value }))}>{label}</MenuItem>)}
    </SidebarPopup>}
    {popup?.type === "recent" && <SidebarPopup popup={popup} close={dismiss} title={t("最近聊天选项", "Recent chat options")}>
      {grouped && <><div className="sidebar-menu-caption">{t("显示", "Show")}</div><MenuItem checked={Boolean(prefs.recentProjects)} onClick={() => choose(() => update({ recentProjects: !prefs.recentProjects }))}>{t("项目中的聊天", "Project chats")}</MenuItem></>}
      <hr/><div className="sidebar-menu-caption">{t("排序方式", "Sort by")}</div>
      {[["updated",t("最近更新", "Last updated")],["created",t("创建时间", "Date created")]].map(([value,label]) => <MenuItem key={value} checked={(prefs.sort || "updated") === value}
        onClick={() => choose(() => update({ sort: value }))}>{label}</MenuItem>)}
    </SidebarPopup>}
    {project && popup.type === "projectMenu" && <ProjectMenu project={project} sections={sections} chats={chats}
      anchor={popup.anchor} onClose={dismiss} open={open} invokeAction={updateProject}/>}
    {project && popup.type === "project" && <SidebarPopup popup={popup} close={dismiss} title={project.name + " 项目详情"} card
      onEnter={() => clearTimeout(timer.current)} onLeave={delayClose}>
      <header><Folder size={16}/><strong>{project.name}</strong>
        <IconButton label={project.pinned ? t("取消置顶项目", "Unpin project") : t("置顶项目", "Pin project")} icon={project.pinned ? PinOff : Pin}
          onClick={() => choose(() => updateProject("setProjectPinned", { projectId: project.id, pinned: !project.pinned }))}/></header>
      <div className="project-chat-count"><MessageSquare size={15}/><span>{active.filter(c => c.projectId === project.id).length} {t("次聊天", "chats")}</span></div>
      {project.folders.length > 0 && <div className="project-card-folders">
        {project.folders.map(folder => <button key={folder} type="button" title={folder}
          onClick={() => choose(() => updateProject("openProjectFolder", {projectId: project.id, folder}))}><Folder size={15}/><span dir="rtl"><bdi dir="ltr">{folder}</bdi></span></button>)}
      </div>}
      <button type="button" className="project-edit" onClick={() => choose(() => open({ type: "project", id: project.id }))}><Settings size={15}/>{t("编辑项目", "Edit project")}</button>
    </SidebarPopup>}
  </aside>;
}
export function ChatSearch({ state, select }) {
  const t = useLanguage();
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const projects = state.projects || [];
  const projectNames = new Map(projects.map(p => [p.id, p.name]));
  const matchedProjects = new Set(projects.filter(p => [p.name, ...p.folders].some(value => value.toLocaleLowerCase().includes(term))).map(p => p.id));
  const matchedMessages = new Set(term ? state.messages.filter(m => m.text?.toLocaleLowerCase().includes(term)).map(m => m.chatId) : []);
  const results = state.chats.filter(chat => !chat.archived && (!term || chat.name.toLocaleLowerCase().includes(term)
    || matchedProjects.has(chat.projectId) || matchedMessages.has(chat.id)));
  return (
    <div className="quick-search">
      <label className="quick-search-input">
        <Search size={16} />
        <input
          data-autofocus
          type="search"
          aria-label={t("搜索会话名称或消息", "Search chat names or messages")}
          placeholder={t("搜索聊天、消息、项目或文件夹", "Search chats, messages, projects or folders")}
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
              <ChatRowTitle>{chat.name}</ChatRowTitle>
              {projectNames.has(chat.projectId) && <small className="search-result-project">{projectNames.get(chat.projectId)}</small>}
              <time>{shortDate(chat.updatedAt)}</time>
            </button>
          );
        })}
        {results.length === 0 && (
          <p>{term ? t("没有找到匹配的对话", "No matching chats") : t("暂无对话", "No chats yet")}</p>
        )}
      </div>
    </div>
  );
}
