import { useLanguage } from "./preferences";
import React, { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, Check, ChevronRight, Pin, PinOff } from "lucide-react";
import { IconButton } from "./ui";
import { ChatRowTitle } from "./ChatRowTitle";

export function shortDate(when, language = "zh-CN") {
  const date = new Date(when);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString(language, { month: "numeric", day: "numeric" });
}

export function ChatRows({ chats, selected, runningIds, select, onChatMenu, onChatAction, menuChatId }) {
  const tr = useLanguage();
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
        <ChatRowTitle>{chat.name}</ChatRowTitle>
        {chat.unread && <i className="chat-unread-dot" aria-label={tr("未读", "Unread")} role="img" />}
        {runningIds.has(chat.id) && <i className="running-dot" role="img" aria-label={tr("正在运行", "Running")} />}
      </button>
      <div className="chat-row-quick">
        {!chat.archived && <IconButton icon={chat.pinned ? PinOff : Pin}
          label={chat.pinned ? tr("取消置顶聊天", "Unpin chat") : tr("置顶聊天", "Pin chat")} onClick={() => onChatAction("pin", chat)} />}
        <IconButton icon={chat.archived ? ArchiveRestore : Archive}
          label={chat.archived ? tr("取消归档聊天", "Unarchive chat") : tr("归档聊天", "Archive chat")} onClick={() => onChatAction("archive", chat)} />
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

export function MenuItem({ icon, children, checked, radio = false, label, detail, onClick }) {
  return <button type="button" role={radio ? "menuitemradio" : checked === undefined ? "menuitem" : "menuitemcheckbox"}
    aria-label={label} aria-description={detail} title={detail} aria-checked={checked} onClick={onClick}>
    {icon}<span className="sidebar-menu-label">{children}{detail && <small className="sidebar-bot-detail">{detail}</small>}</span>
    {checked && <Check size={14}/>}</button>;
}

export function SidebarPopup({ popup, close, title, card = false, onEnter, onLeave, children }) {
  const ref = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const node = ref.current;
    const { anchor } = popup;
    function position() {
      if (!anchor.isConnected) { closeRef.current(); return; }
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth, height = node.offsetHeight;
      const x = card && rect.right + width + 9 <= window.innerWidth ? rect.right + 6 : rect.left;
      const y = card ? rect.top : rect.bottom + 4 + height < window.innerHeight ? rect.bottom + 4 : rect.top - height - 4;
      node.style.left = Math.max(5, Math.min(x, window.innerWidth - width - 5)) + "px";
      node.style.top = Math.max(5, Math.min(y, window.innerHeight - height - 5)) + "px";
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(node);
    const outside = e => {
      if (!node.contains(e.target) && !anchor.contains(e.target)) closeRef.current();
    };
    const key = e => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); closeRef.current();
        if (popup.keyboard || node.contains(document.activeElement)) (popup.trigger || anchor).focus({ preventScroll: true });
      }
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    if (popup.keyboard) (node.querySelector('[role="menuitemradio"][aria-checked="true"]') || node.querySelector("button:enabled"))?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [popup, card]);
  return createPortal(<div ref={ref} className={card ? "project-detail-card" : "sidebar-options-menu"} role={card ? "dialog" : "menu"}
    aria-label={title} onPointerEnter={onEnter} onPointerLeave={onLeave} onKeyDown={e => {
      if (e.key === "Tab" && !card) {
        (popup.trigger || popup.anchor).focus({ preventScroll: true });
        close(); return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = [...ref.current.querySelectorAll("button:enabled")];
      if (!buttons.length) return;
      e.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
        : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }}>{children}</div>, document.body);
}
