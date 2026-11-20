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

function shortDate(when) {
  const time = new Date(when);
  if (!Number.isFinite(time.getTime())) return "";
  if (time.toDateString() === new Date().toDateString())
    return time.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return time.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function ChatList({
  title,
  kind,
  chats,
  tasks,
  messages,
  selected,
  disabled,
  select,
  open,
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="rail-section">
      <div className="rail-section-heading">
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <span>{title}</span>
          <ChevronRight size={12} className={expanded ? "turned" : ""} />
        </button>
        <IconButton
          icon={Plus}
          label={"新建" + title}
          disabled={disabled}
          onClick={() => open({ type: "chat", kind })}
        />
      </div>
      {expanded &&
        (chats.length ? (
          chats.map((chat) => {
            const duplicate = chats.some(
              (other) => other.id !== chat.id && other.name === chat.name,
            );
            const excerpt = duplicate
              ? messages.find(
                  (m) => m.chatId === chat.id && m.author === "user",
                )?.text
              : "";
            const display = excerpt ? `${chat.name} · ${excerpt}` : chat.name;
            const running = tasks.some(
              (t) =>
                t.chatId === chat.id &&
                ["running", "approval", "queued"].includes(t.status),
            );
            const Icon = kind === "group" ? UsersRound : MessageSquare;
            return (
              <button
                key={chat.id}
                className="rail-row thread-row"
                aria-current={selected === chat.id ? "page" : undefined}
                title={display}
                onClick={() => select(chat.id)}
              >
                <Icon size={16} />
                <span>{display}</span>
                {running ? (
                  <i className="running-dot" aria-label="正在运行" />
                ) : (
                  <time dateTime={chat.updatedAt}>
                    {shortDate(chat.updatedAt)}
                  </time>
                )}
              </button>
            );
          })
        ) : (
          <div className="rail-empty">暂无{title}</div>
        ))}
    </section>
  );
}
export function Sidebar({
  state,
  page,
  select,
  open,
  disabled,
  collapse,
  history,
}) {
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
        {[
          ["direct", "私聊"],
          ["group", "群聊"],
        ].map(([kind, title]) => (
          <ChatList
            key={kind}
            kind={kind}
            title={title}
            disabled={disabled}
            selected={page}
            select={select}
            open={open}
            chats={disabled ? [] : state.chats.filter((c) => c.kind === kind)}
            tasks={state.tasks}
            messages={state.messages}
          />
        ))}
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
