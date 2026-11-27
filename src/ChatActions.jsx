import { useLanguage } from "./preferences";
import React, { useEffect, useRef, useState } from "react";
import { Button, errorText, Field, Modal, Notice } from "./ui";

const copyFormats = {
  copyId: "id", copyLink: "link", copyMarkdown: "text", copyWorkingDirectory: "cwd",
};
const copyMessages = {
  copyId: "已复制会话 ID", copyLink: "已复制聊天链接", copyMarkdown: "已复制为 Markdown", copyWorkingDirectory: "已复制工作目录",
};
const dialogActions = new Set(["rename", "newSection", "delete"]);
const directoryActions = new Set(["copyWorkingDirectory", "showInFinder", "openTarget"]);

export function useChatActions({ state, page, currentPage, dialog, setDialog, invoke, select, refresh, setError }) {
  const tr = useLanguage();
  const [menu, setMenu] = useState(null);
  const [openTargets, setOpenTargets] = useState([]);
  const [notice, setNotice] = useState("");
  const locked = useRef(new Set());
  const noticeTimer = useRef(null);
  const menuChat = menu && state.chats.find(chat => chat.id === menu.chatId);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => { setMenu(null); }, [page]);
  useEffect(() => {
    if (!menu || menuChat) return;
    setMenu(null);
  }, [menu, menuChat]);
  useEffect(() => {
    if (menu?.variant !== "header") return;
    let current = true;
    invoke("chatOpenTargets").then(targets => {
      if (current) setOpenTargets(targets);
    }).catch(() => { if (current) setOpenTargets([]); });
    return () => { current = false; };
  }, [menu, invoke]);

  function announce(message, timeout = 2300) {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    if (timeout) noticeTimer.current = setTimeout(() => setNotice(""), timeout);
  }
  function showMenu(chat, anchor, variant) {
    setMenu(previous => previous?.chatId === chat.id && previous.variant === "header" && variant === "header"
      ? null : { chatId: chat.id, anchor, variant });
  }
  async function act(action, item, payload = {}) {
    const chat = state.chats.find(c => c.id === item?.id);
    if (!chat) return;
    setMenu(null);
    if (dialogActions.has(action)) {
      setDialog({ type: "chatAction", action, id: chat.id });
      return;
    }
    if (locked.current.has(chat.id)) return;
    locked.current.add(chat.id);
    const startPage = currentPage.current;
    const chatId = chat.id;
    try {
      let botId = payload.botId;
      if (directoryActions.has(action) && !botId && chat.members.length > 1) {
        const directories = await invoke("chatDirectories", { chatId });
        if (directories.length > 1) {
          if (currentPage.current === startPage) setDialog({ type: "directory", action, id: chatId, payload, directories });
          return;
        }
        botId = directories[0]?.botId;
      }
      if (Object.hasOwn(copyFormats, action)) {
        await invoke("copyChat", { chatId, format: copyFormats[action], botId });
        announce(copyMessages[action]);
        return;
      }
      switch (action) {
        case "share":
          await invoke("shareChat", { chatId, x: payload.x, y: payload.y });
          return;
        case "openWindow":
          await invoke("openChatWindow", { chatId });
          return;
        case "showInFinder":
        case "openTarget":
          await invoke("openChatDirectory", { chatId, botId, target: payload.target || "finder" });
          return;
        case "fork":
        case "forkWorktree": {
          announce(action === "forkWorktree" ? tr("正在新工作树中创建聊天分支…", "Creating chat branch in a new worktree…") : tr("正在创建聊天分支…", "Branching chat…"), 0);
          const id = await invoke(action === "forkWorktree" ? "forkChatInWorktree" : "forkChat", { chatId });
          await refresh();
          // Right-clicking another row targets that chat. An intervening navigation keeps its destination.
          if (currentPage.current === startPage) select(id);
          announce(tr("已创建聊天分支", "Chat branch created"));
          return;
        }
        case "pin":
          await invoke("setChatPinned", { chatId, pinned: !chat.pinned });
          break;
        case "unread":
          await invoke("setChatUnread", { chatId, unread: !chat.unread });
          break;
        case "moveSection":
          await invoke("moveChatToSection", { chatId, sectionId: payload.sectionId ?? null });
          break;
        case "moveProject":
          await invoke("moveChatToProject", { chatId, projectId: payload.projectId ?? null });
          break;
        case "archive":
          await invoke("setChatArchived", { chatId, archived: !chat.archived });
          if (!chat.archived && currentPage.current === chat.id) select("home");
          announce(chat.archived ? tr("聊天已恢复", "Chat restored") : tr("聊天已归档", "Chat archived"));
          break;
        default:
          return;
      }
      await refresh();
    } catch (error) {
      announce("");
      setError(errorText(error));
    } finally {
      locked.current.delete(chatId);
    }
  }

  useEffect(() => {
    if (dialog || !state.onboarded) return;
    function keydown(event) {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey)) return;
      const targetId = menuChat?.id || event.target.closest?.("[data-chat-id]")?.dataset.chatId || page;
      const target = state.chats.find(chat => chat.id === targetId);
      if (!target) return;
      const actions = event.altKey && !event.shiftKey ? { KeyR: "rename", KeyP: "pin" }
        : event.shiftKey && !event.altKey ? { KeyU: "unread", KeyA: "archive" } : {};
      const action = actions[event.code];
      if (!action) return;
      event.preventDefault();
      act(action, target);
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  return { menu, menuChat, openTargets, showMenu, closeMenu: () => setMenu(null), act, notice };
}

export function ChatActionDialog({ chat, action, invoke, onDone, onClose }) {
  const tr = useLanguage();
  const [value, setValue] = useState(action === "rename" ? chat.name : "");
  const [suggestion, setSuggestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const deleting = action === "delete";
  const rename = action === "rename";
  useEffect(() => {
    if (!rename) return;
    let active = true;
    invoke("suggestChatTitle", { chatId: chat.id }).then(title => {
      if (active) setSuggestion(title);
    }).catch(() => {});
    return () => { active = false; };
  }, [chat.id, invoke, rename]);
  const title = deleting ? tr("永久删除聊天？", "Permanently delete chat?") : rename ? tr("重命名聊天", "Rename chat") : tr("新建分区", "New section");
  async function submit(event) {
    event.preventDefault();
    if (pending.current || (!deleting && !value.trim())) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const method = deleting ? "deleteChat" : rename ? "renameChat" : "createChatSection";
      await invoke(method, { chatId: chat.id, ...(!deleting && { name: value.trim() }) });
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <Modal title={title} onClose={() => { if (!pending.current) onClose(); }}>
    <form onSubmit={submit}>
      {deleting
        ? <p className="chat-delete-description">{tr("BoTeam 将永久删除「", "BoTeam will permanently delete the chat history and exclusive attachments for “")}{chat.name}{tr("」的聊天记录和独占附件。原生工具的历史、工作目录及已有分支会保留。此操作无法撤销。", "”. CLI history, working directories and existing branches will be kept. This cannot be undone.")}</p>
        : <Field label={rename ? tr("聊天名称", "Chat name") : tr("分区名称", "Section name")}>
          <input data-autofocus type="text" value={value} required maxLength={120}
            onFocus={e => e.target.select()} onChange={e => setValue(e.target.value)} />
        </Field>}
      {rename && suggestion && suggestion !== value.trim() &&
        <button className="text-btn" type="button" disabled={busy} onClick={() => setValue(suggestion)}>{tr("根据首条消息生成", "Generate from first message")}</button>}
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button data-autofocus={deleting || undefined} disabled={busy} onClick={onClose}>{tr("取消", "Cancel")}</Button>
        <Button type="submit" variant={deleting ? "danger" : "primary"} busy={busy} disabled={!deleting && !value.trim()}>
          {deleting ? tr("永久删除", "Delete permanently") : rename ? tr("保存", "Save") : tr("创建并移入", "Create and move")}
        </Button>
      </div>
    </form>
  </Modal>;
}
