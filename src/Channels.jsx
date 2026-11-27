import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, RotateCw, Search, SlidersHorizontal } from "lucide-react";
import { platforms } from "../desktop/channels/catalog.mjs";
import { useLanguage } from "./preferences";
import { Button, IconButton, Notice, errorText } from "./ui";
import { PlatformIcon, statusLabel } from "./ChannelPlatform";
import { ChannelSetupDialog } from "./ChannelSetupDialog";
import { ChatRowTitle } from "./ChatRowTitle";
import "./channels.css";

function readExpandedGroups() {
  try { return JSON.parse(localStorage.getItem("boteam:channel-groups")) || {}; } catch { return {}; }
}

function ChannelChatRow({ chat, platformName, record, taskStatus, active, onOpen, onMenu }) {
  const t = useLanguage();
  const prefix = platformName + " · ";
  const title = chat.name.startsWith(prefix) ? chat.name.slice(prefix.length) || chat.name : chat.name;
  let status;
  if (taskStatus === "approval") status = t("等待确认", "Needs approval");
  else if (taskStatus) status = t("进行中", "Running");
  else if (chat.unconfirmed) status = t("送达待确认", "Delivery unconfirmed");
  else if (record?.unread) status = t("未读", "Unread");

  function openMenu(event, keyboard) {
    if (!record) return;
    event.preventDefault();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    anchor.focus({ preventScroll: true });
    onMenu(record, { anchor, x: keyboard ? rect.left + 12 : event.clientX, y: keyboard ? rect.bottom : event.clientY }, "context");
  }

  return <button type="button" className="rail-row thread-row channel-chat" data-chat-id={chat.id}
    aria-current={active ? "page" : undefined} title={status ? title + " · " + status : title}
    onClick={() => onOpen(chat.id)} onContextMenu={event => openMenu(event, false)}
    onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openMenu(event, true); }}>
    <ChatRowTitle>{title}</ChatRowTitle>
    {status && <i className={"channel-chat-status " + (taskStatus || (chat.unconfirmed ? "unconfirmed" : "unread"))}
      role="img" aria-label={status}/>}
  </button>;
}

export function ChannelNavigation({ state, activeChatId, onOverview, onOpenChat, onChatMenu }) {
  const t = useLanguage();
  const [expanded, setExpanded] = useState(readExpandedGroups);
  const [filter, setFilter] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState({});
  const channels = state.channels || [];
  const configs = new Map(channels.map(channel => [channel.id, channel]));
  const configured = channels.filter(channel => channel.configured).length;
  const activePlatformId = activeChatId && channels.find(channel => channel.chats?.some(chat => chat.id === activeChatId))?.id;
  useEffect(() => {
    if (activePlatformId) setExpanded(old => old[activePlatformId] ? old : { ...old, [activePlatformId]: true });
  }, [activeChatId, activePlatformId]);
  useEffect(() => { localStorage.setItem("boteam:channel-groups", JSON.stringify(expanded)); }, [expanded]);

  const needle = query.trim().toLocaleLowerCase();
  const groups = platforms.flatMap(platform => {
    const config = configs.get(platform.id);
    const chats = config?.chats || [];
    if (filter === "connected" && config?.status !== "connected") return [];
    if (filter === "chats" && !chats.length) return [];
    if (platform.name.toLocaleLowerCase().includes(needle)) return [{ platform, chats }];
    const matching = chats.filter(chat => chat.name.toLocaleLowerCase().includes(needle));
    return matching.length ? [{ platform, chats: matching }] : [];
  });
  const chatById = new Map(state.chats.map(chat => [chat.id, chat]));
  const taskStatus = new Map();
  for (const task of state.tasks) {
    if (["approval", "running", "queued"].includes(task.status) && taskStatus.get(task.chatId) !== "approval")
      taskStatus.set(task.chatId, task.status);
  }
  const filters = [["all", t("全部", "All")], ["chats", t("有会话", "With chats")], ["connected", t("已连接", "Connected")]];
  const searchLabel = t("搜索频道会话", "Search channel chats");
  function updateQuery(value) {
    setQuery(value);
    setSearchExpanded({});
  }

  return <>
    <div className="rail-primary">
      <div className="workbench-heading channel-nav-heading">
        <button type="button" className="workbench-switch channel-overview" aria-current={activeChatId ? undefined : "page"} onClick={onOverview}>
          <SlidersHorizontal size={16}/><span>{t("频道配置", "Channel configuration")}</span>
          <small>{configured}/{platforms.length}</small>
        </button>
        <IconButton label={searchLabel} icon={Search} aria-expanded={searchOpen} onClick={() => {
          setSearchOpen(!searchOpen);
          updateQuery("");
        }}/>
      </div>
      {searchOpen && <label className="channel-search channel-session-search"><Search size={14}/>
        <input autoFocus type="search" aria-label={searchLabel} placeholder={t("搜索平台或会话", "Search platforms or chats")}
          value={query} onChange={e => updateQuery(e.target.value)}/>
      </label>}
      <div className="channel-filters" role="group" aria-label={t("筛选频道会话", "Filter channel chats")}>
        {filters.map(([value, label]) => <button key={value} type="button" aria-pressed={value === filter} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </div>
    <nav className="rail-history channel-groups" aria-label={t("平台会话", "Platform chats")}>
      {groups.map(({ platform, chats }) => {
        const open = needle ? (searchExpanded[platform.id] ?? !!chats.length) : (expanded[platform.id] ?? !!chats.length);
        const update = needle ? setSearchExpanded : setExpanded;
        return <div className="channel-group" key={platform.id}>
          <button type="button" className="rail-row project-toggle channel-group-toggle" aria-expanded={open} aria-label={platform.name}
            onClick={() => update(old => ({ ...old, [platform.id]: !open }))}>
            <PlatformIcon id={platform.id}/><span>{platform.name}</span><ChevronRight className="channel-chevron" size={13}/>
          </button>
          {open && <div className="project-chats">
            {chats.map(chat => <ChannelChatRow key={chat.id} chat={chat} platformName={platform.name} record={chatById.get(chat.id)}
              taskStatus={taskStatus.get(chat.id)} active={chat.id === activeChatId} onOpen={onOpenChat} onMenu={onChatMenu}/>)}
            {!chats.length && <p className="rail-empty">{t("暂无会话", "No chats yet")}</p>}
          </div>}
        </div>;
      })}
      {!groups.length && <p className="rail-empty">{needle ? t("没有匹配的平台或会话", "No matching platforms or chats") :
        filter === "connected" ? t("暂无已连接的平台", "No connected platforms yet") : t("暂无频道会话", "No channel chats yet")}</p>}
    </nav>
  </>;
}

export function Channels({ select, state, invoke, refreshSnapshot }) {
  const t = useLanguage();
  const [dialogId, setDialogId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const configs = new Map((state.channels || []).map(row => [row.id, row]));
  const needle = query.trim().toLocaleLowerCase();
  const setup = platforms.find(p => p.id === dialogId);
  const cards = platforms.filter(p => [p.name, ...p.description].some(text => text.toLocaleLowerCase().includes(needle)));

  async function refresh() {
    setBusy(true); setError("");
    try { await invoke("channelRefresh"); await refreshSnapshot(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <div className="page-scroll channel-page">
    <section className="channel-directory">
      <header className="channel-toolbar">
        <div><h2>{t("平台配置", "Platform connections")}</h2>
          <p>{t("连接聊天应用，在 BoTeam 中接收和回复消息。", "Connect your messaging apps to receive and reply to messages in BoTeam.")}</p></div>
        <div className="channel-tools">
          <label className="channel-search"><Search size={15}/><input type="search" aria-label={t("搜索频道", "Search channels")}
            placeholder={t("搜索平台", "Search platforms")} value={query} onChange={e => setQuery(e.target.value)}/></label>
          <IconButton label={t("刷新频道", "Refresh channels")} icon={RotateCw} className={busy ? "channel-refreshing" : ""} disabled={busy} onClick={refresh}/>
        </div>
      </header>
      <Notice>{error}</Notice>
      <div className="channel-grid">
        {cards.map(p => {
          const config = configs.get(p.id);
          return <article key={p.id} className="channel-card" data-channel={p.id}>
            <PlatformIcon id={p.id}/>
            <div className="channel-card-info"><h2>{p.name}</h2><p>{t(...p.description)}</p>
              {config?.configured && <small className={"channel-status " + config.status}>{statusLabel(config.status, t)}</small>}
            </div>
            <Button aria-label={t("配置 ", "Configure ") + p.name} onClick={() => setDialogId(p.id)}>
              {config?.configured ? t("管理", "Manage") : t("配置", "Configure")}</Button>
          </article>;
        })}
      </div>
      {!cards.length && <p className="channel-no-results">{t("没有匹配的平台", "No matching platforms")}</p>}
    </section>
    {setup && createPortal(<ChannelSetupDialog key={setup.id} platform={setup} config={configs.get(setup.id)}
      state={state} invoke={invoke} refreshSnapshot={refreshSnapshot} onClose={() => setDialogId("")} onManageBots={() => select("bots")}/>, document.body)}
  </div>;
}
