import React, { useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  SquarePen,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { Brand, IconButton } from "./ui";

import { ChatRows, SidebarSection, shortDate } from "./SidebarParts";

export function Sidebar({
  state,
  page,
  select,
  open,
  disabled,
  collapse,
  history,
  onChatMenu, onChatAction, menuChatId,
}) {
  const [folded, setFolded] = useState({ archived: true });
  const chats = disabled ? [] : state.chats;
  const runningIds = new Set(state.tasks.filter(t => ["running", "approval", "queued"].includes(t.status)).map(t => t.chatId));
  const sections = state.chatSections || [];
  const sectionIds = new Set(sections.map(s => s.id));
  const groups = [
    { id: "pinned", title: "置顶", chats: chats.filter(c => c.pinned && !c.archived) },
    ...sections.map(s => ({ ...s, title: s.name, chats: chats.filter(c => !c.pinned && !c.archived && c.sectionId === s.id) })),
    { id: "recent", title: "最近", chats: chats.filter(c => !c.pinned && !c.archived && !sectionIds.has(c.sectionId)) },
    { id: "archived", title: "已归档", chats: chats.filter(c => c.archived) },
  ];
  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sidebar-titlebar">
        <IconButton label="收起侧栏" icon={PanelLeftClose} onClick={collapse} />
        <IconButton
          label="后退"
          icon={ChevronLeft}
          disabled={!history.back || disabled}
          onClick={() => history.move(-1)}
        />
        <IconButton
          label="前进"
          icon={ChevronRight}
          disabled={!history.forward || disabled}
          onClick={() => history.move(1)}
        />
      </div>
      <nav className="rail-primary" aria-label="工作台">
        <button
          className="rail-workspace"
          title="工作台首页"
          disabled={disabled}
          onClick={() => select("home")}
        >
          <Brand />
        </button>
        <button
          className="rail-row"
          onClick={() => select("home")}
          disabled={disabled}
          aria-current={!disabled && page === "home" ? "page" : undefined}
        >
          <SquarePen />
          <span>新建对话</span>
          <kbd>⌘ N</kbd>
        </button>
        <button
          className="rail-row"
          onClick={() => open({ type: "search" })}
          disabled={disabled}
        >
          <Search />
          <span>搜索对话</span>
          <kbd>⌘ K</kbd>
        </button>
      </nav>
      <nav className="rail-history" aria-label="聊天列表">
        {groups.filter(g => g.chats.length || g.id === "recent" || sectionIds.has(g.id)).map(g =>
          <SidebarSection key={g.id} title={g.title} expanded={!folded[g.id]}
            toggle={() => setFolded({ ...folded, [g.id]: !folded[g.id] })}
            actions={g.id === "recent" && <IconButton icon={Plus} label="开始新聊天" disabled={disabled}
              onClick={() => open({ type: "chat" })} />}>
            <ChatRows chats={g.chats} selected={page} runningIds={runningIds} select={select}
              onChatMenu={onChatMenu} onChatAction={onChatAction} menuChatId={menuChatId}/>
          </SidebarSection>)}
      </nav>
      <nav className="rail-settings" aria-label="管理">
        {[
          [Bot, "Bot 管理", "bots"],
          [WalletCards, "账号管理", "accounts"],
        ].map(([Icon, label, id]) => (
          <button
            key={id}
            className="rail-row"
            disabled={disabled}
            aria-current={page === id && !disabled ? "page" : undefined}
            onClick={() => select(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
export function ChatSearch({ state, select }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const results = state.chats.filter(
    (chat) =>
      chat.name.toLocaleLowerCase().includes(term) ||
      state.messages.some(
        (m) =>
          m.chatId === chat.id && m.text.toLocaleLowerCase().includes(term),
      ),
  );
  return (
    <div className="quick-search">
      <label className="quick-search-input">
        <Search size={16} />
        <input
          data-autofocus
          type="search"
          aria-label="搜索会话名称或消息"
          placeholder="搜索会话名称或消息"
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
