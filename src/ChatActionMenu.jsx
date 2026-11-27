import { useLanguage } from "./preferences";
import React from "react";
import { ActionMenu } from "./ActionMenu";
import {
  AppWindow, Archive, ArchiveRestore, ArrowUpRight, Copy, Eye, EyeOff,
  FileText, Folder, FolderPlus, Hash, Link2, List, Pencil, Pin, PinOff, Split, Trash2, Upload,
} from "lucide-react";

const mac = /Mac/i.test(navigator.platform);
const shortcut = (letter, shift = false) => mac
  ? (shift ? "⇧⌘" : "⌥⌘") + letter : "Ctrl+" + (shift ? "Shift+" : "Alt+") + letter;

function menuGroups(chat, sections, projects, header, openTargets, tr) {
  const rename = { id: "rename", text: tr("重命名", "Rename"), icon: Pencil, key: shortcut("R") };
  const pin = { id: "pin", text: chat.pinned ? tr("取消置顶", "Unpin") : header ? tr("置顶聊天", "Pin chat") : tr("置顶", "Pin"),
    icon: chat.pinned ? PinOff : Pin, key: shortcut("P") };
  const unread = { id: "unread", text: chat.unread ? tr("标记为已读", "Mark as read") : tr("标记为未读", "Mark as unread"),
    icon: chat.unread ? EyeOff : Eye, key: shortcut("U", true) };
  const archive = { id: "archive", text: chat.archived ? tr("取消归档", "Unarchive") : tr("归档", "Archive"),
    icon: chat.archived ? ArchiveRestore : Archive, key: shortcut("A", true) };
  const remove = { id: "delete", text: header ? "Delete" : tr("永久删除", "Delete permanently"), icon: Trash2, danger: true };
  const copy = { id: "copy", text: tr("复制", "Copy"), icon: Copy, children: [
    { id: "copyLink", text: tr("复制深度链接", "Copy deep link"), icon: Link2 },
    { id: "copyMarkdown", text: tr("复制为 Markdown", "Copy as Markdown"), icon: FileText },
    { id: "copyId", text: tr("复制会话 ID", "Copy chat ID"), icon: Hash },
    { id: "copyWorkingDirectory", text: tr("复制工作目录", "Copy working directory"), icon: Folder },
  ] };
  const newWindow = { id: "openWindow", text: tr("在新窗口中打开", "Open in new window"), icon: AppWindow };
  if (header) return [[rename, pin, { id: "fork", text: "Fork chat", icon: Split }, copy,
    { id: "open", text: tr("打开方式", "Open with"), icon: ArrowUpRight, children: [newWindow, ...(openTargets.length
      ? openTargets.map(target => ({ id: "openTarget", text: target.label, payload: { target: target.id } }))
      : [{ id: "showInFinder", text: mac ? tr("在 Finder 中显示", "Show in Finder") : tr("在文件管理器中显示", "Show in file manager"), icon: Folder }])] }, archive, remove]];
  return [
    [rename, pin, unread, { id: "sections", text: tr("分区", "Section"), icon: List, children: [
      { id: "moveSection", text: tr("默认分区", "Default section"),
        selected: !chat.sectionId && !chat.pinned, payload: { sectionId: null } },
      ...sections.map(section => ({ id: "moveSection", text: section.name,
        selected: section.id === chat.sectionId && !chat.pinned, payload: { sectionId: section.id } })),
      { id: "newSection", text: tr("新建分区…", "New section…"), icon: FolderPlus },
    ] }, ...(projects.length ? [{ id: "projects", text: tr("移至项目", "Move to project"), icon: Folder, children: [
      { id: "moveProject", text: tr("不加入项目", "No project"), selected: !chat.projectId, payload: { projectId: null } },
      ...projects.map(project => ({ id: "moveProject", text: project.name,
        selected: project.id === chat.projectId, payload: { projectId: project.id } })),
    ] }] : [])],
    [{ id: "forks", text: tr("分叉", "Branch"), icon: Split, children: [
      { id: "fork", text: tr("在同一工作树中创建聊天分支", "Branch in this worktree") }, { id: "forkWorktree", text: tr("在新工作树中创建聊天分支", "Branch in a new worktree") },
    ] }],
    [{ id: "share", text: tr("分享", "Share"), icon: Upload }, copy],
    [newWindow], [archive, remove],
  ];
}

export function ChatActionMenu({ chat, sections = [], projects = [], openTargets = [], anchor, variant, onAction, onClose }) {
  const tr = useLanguage();
  const header = variant === "header";
  return <ActionMenu label={header ? tr("更多聊天操作", "More chat actions") : tr("聊天快捷菜单", "Chat actions")}
    groups={menuGroups(chat, sections, projects, header, openTargets, tr)} anchor={anchor} variant={variant} onClose={onClose}
    onAction={(item, rect) => onAction(item.id, chat, item.id === "share"
      ? { x: Math.round(rect.left), y: Math.round(rect.bottom) } : item.payload)}/>;
}
