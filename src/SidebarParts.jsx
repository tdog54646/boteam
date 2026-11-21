import React from "react";
import { Archive, ArchiveRestore, ChevronRight, Pin, PinOff } from "lucide-react";
import { IconButton } from "./ui";

export function shortDate(when) {
  const date = new Date(when);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function ChatRows({ chats, selected, runningIds, select, onChatMenu, onChatAction, menuChatId }) {
  return chats.map(chat => {
    function context(event, keyboard) {
      event.preventDefault();
      const anchor = event.currentTarget.querySelector(".thread-row");
      const rect = anchor.getBoundingClientRect();
      anchor.focus({ preventScroll: true });
      onChatMenu(chat, { anchor, x: keyboard ? rect.left + 12 : event.clientX, y: keyboard ? rect.bottom : event.clientY }, "context");
    }
    return <div key={chat.id} data-chat-id={chat.id}
      className={`chat-row-wrap ${chat.unread ? "chat-unread" : ""} ${chat.id === menuChatId ? "context-active" : ""}`}
      onContextMenu={e => context(e, false)} onKeyDown={e => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) context(e, true);
      }}>
      <button className="rail-row thread-row" aria-current={selected === chat.id ? "page" : undefined}
        title={chat.name} onClick={() => select(chat.id)}>
        <span>{chat.name}</span>
        {chat.unread && <i className="chat-unread-dot" aria-label="未读" role="img" />}
        {runningIds.has(chat.id) && <i className="running-dot" role="img" aria-label="正在运行" />}
      </button>
      <div className="chat-row-quick">
        {!chat.archived && <IconButton icon={chat.pinned ? PinOff : Pin}
          label={chat.pinned ? "取消置顶聊天" : "置顶聊天"} onClick={() => onChatAction("pin", chat)} />}
        <IconButton icon={chat.archived ? ArchiveRestore : Archive}
          label={chat.archived ? "取消归档聊天" : "归档聊天"} onClick={() => onChatAction("archive", chat)} />
      </div>
    </div>;
  });
}

export function SidebarSection({ title, expanded, toggle, actions, children }) {
  return <section className="rail-section" aria-label={title}>
    <div className="rail-section-heading">
      <button aria-expanded={expanded} onClick={toggle}><span>{title}</span><ChevronRight size={12} className={expanded ? "turned" : ""}/></button>
      <div className="section-tools">{actions}</div>
    </div>
    {expanded && children}
  </section>;
}
