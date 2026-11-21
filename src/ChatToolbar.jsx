import React from "react";
import { Ellipsis, Upload } from "lucide-react";
import { IconButton } from "./ui";
import "./chat-toolbar.css";

export function ChatToolbar({ chat, onChatMenu, onChatAction, menuOpen }) {
  return (
    <div className="chat-tools">
        <IconButton icon={Ellipsis} label="更多聊天操作" aria-haspopup="menu" aria-expanded={!!menuOpen}
          onClick={event => {
            const anchor = event.currentTarget;
            const rect = anchor.getBoundingClientRect();
            onChatMenu(chat, { x: rect.right, y: rect.bottom, anchor }, "header");
          }} />
        <IconButton icon={Upload} label="分享聊天" onClick={event => {
          const { left, bottom } = event.currentTarget.getBoundingClientRect();
          onChatAction("share", chat, { x: Math.round(left), y: Math.round(bottom) });
        }} />
    </div>
  );
}
