import React, { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Bot, CalendarCheck, ChevronLeft, ChevronRight, House, MessageSquare, MessagesSquare, PanelLeftClose, Search, Settings, Trash2, UsersRound, WalletCards } from "lucide-react";
import { IconButton } from "./ui";
import { UserMenu } from "./UserMenu";
import { useLanguage } from "./preferences";
import "./workspace-navigation.css";

export const settingsPages = ["archived", "bots", "accounts"];

export function WorkspaceNavigation({ section, select, disabled, settingsPage }) {
  const t = useLanguage();
  function link(id, label, Icon, destination = id) {
    const active = section === id;
    return <button type="button" className="workspace-destination" aria-label={label}
      disabled={disabled} aria-current={active ? "page" : undefined} onClick={() => select(destination)}>
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
    </button>;
  }
  return <nav className="workspace-navigation" aria-label={t("主导航", "Main navigation")}>
    {link("home", t("首页", "Home"), House)}
    {link("schedules", t("定时任务", "Schedules"), CalendarCheck)}
    {link("channels", t("频道", "Channels"), MessagesSquare)}
    <div className="workspace-navigation-bottom">
      {link("settings", t("设置", "Settings"), Settings, settingsPage)}
      <UserMenu />
    </div>
  </nav>;
}

export function HistoryButtons({ history, disabled }) {
  const t = useLanguage();
  return <>
    <IconButton label={t("后退", "Back")} icon={ChevronLeft} disabled={!history.back || disabled} onClick={() => history.move(-1)}/>
    <IconButton label={t("前进", "Forward")} icon={ChevronRight} disabled={!history.forward || disabled} onClick={() => history.move(1)}/>
  </>;
}

export function SidebarTitlebar({ collapse, history, disabled }) {
  const t = useLanguage();
  return <div className="sidebar-titlebar">
    <IconButton label={t("收起侧栏", "Collapse sidebar")} icon={PanelLeftClose} onClick={collapse}/>
    <HistoryButtons history={history} disabled={disabled}/>
  </div>;
}

export function SettingsNavigation({ page, select }) {
  const t = useLanguage();
  const items = [
    ["bots", Bot, t("Bot 管理", "Bots")],
    ["accounts", WalletCards, t("账号管理", "CLI accounts")],
    ["archived", Archive, t("已归档会话", "Archived chats")],
  ];
  return <nav className="settings-navigation" aria-label={t("设置分类", "Settings categories")}>
    <h2>{t("设置", "Settings")}</h2>
    {items.map(([id, Icon, label]) => <button key={id} type="button" className="rail-row"
      aria-current={page === id ? "page" : undefined} onClick={() => select(id)}>
      <Icon size={16} aria-hidden="true"/><span>{label}</span>
    </button>)}
  </nav>;
}

export function ArchivedChats({ state, select, action }) {
  const t = useLanguage();
  const [query, setQuery] = useState("");
  const archived = state.chats.filter(chat => chat.archived);
  const summaries = new Map(state.projects.map(project => [project.id, project.name]));
  const bots = new Map(state.bots.map(bot => [bot.id, bot.name]));
  const term = query.trim().toLocaleLowerCase();
  const rows = archived.map(chat => {
    const detail = [summaries.get(chat.projectId), ...chat.members.map(id => bots.get(id))].filter(Boolean).join(" · ");
    return { chat, detail };
  }).filter(({chat, detail}) => (chat.name + " " + detail).toLocaleLowerCase().includes(term));
  return <div className="page-scroll"><article className="settings-page archive-page">
    <header className="settings-heading">
      <h1>{t("已归档会话", "Archived chats")}</h1>
      <p>{t("在这里查看已归档的聊天，或将它们恢复到首页。", "View archived chats or restore them to Home.")}</p>
    </header>
    {archived.length > 0 && <label className="account-search">
      <Search size={15}/><input type="search" aria-label={t("搜索已归档会话", "Search archived chats")}
        placeholder={t("搜索会话、项目或 Bot", "Search chats, projects, or bots")} value={query} onChange={e => setQuery(e.target.value)}/>
    </label>}
    <div className="settings-group">
      {rows.map(({chat, detail}) => {
        const Icon = chat.kind === "group" ? UsersRound : MessageSquare;
        return <div className="settings-row archived-chat-row" key={chat.id} data-chat-id={chat.id}>
          <button type="button" className="archived-chat-link" onClick={() => select(chat.id)}>
            <Icon size={17} aria-hidden="true"/><span className="row-copy"><strong>{chat.name}</strong><small>{detail}</small></span>
          </button>
          <time dateTime={chat.updatedAt}>{new Date(chat.updatedAt).toLocaleDateString(document.documentElement.lang)}</time>
          <IconButton label={t("取消归档聊天", "Restore chat")} icon={ArchiveRestore} onClick={() => action("archive", chat)}/>
          <IconButton label={t("永久删除聊天", "Delete chat permanently")} icon={Trash2} onClick={() => action("delete", chat)}/>
        </div>;
      })}
      {!rows.length && <p className="settings-empty">{archived.length ? t("没有匹配的会话", "No matching chats") : t("暂无已归档会话", "No archived chats")}</p>}
    </div>
  </article></div>;
}
