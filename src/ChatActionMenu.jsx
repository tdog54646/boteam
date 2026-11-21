import React from "react";
import { ActionMenu } from "./ActionMenu";
import {
  AppWindow, Archive, ArchiveRestore, ArrowUpRight, Copy, Eye, EyeOff,
  FileText, Folder, FolderPlus, Hash, Link2, List, Pencil, Pin, PinOff, Trash2, Upload,
} from "lucide-react";

const mac = /Mac/i.test(navigator.platform);
const shortcut = (letter, shift = false) => mac
  ? (shift ? "⇧⌘" : "⌥⌘") + letter : "Ctrl+" + (shift ? "Shift+" : "Alt+") + letter;

function menuGroups(chat, sections, projects, header, openTargets) {
  const rename = { id: "rename", text: "重命名", icon: Pencil, key: shortcut("R") };
  const pin = { id: "pin", text: chat.pinned ? "取消置顶" : header ? "置顶聊天" : "置顶",
    icon: chat.pinned ? PinOff : Pin, key: shortcut("P") };
  const unread = { id: "unread", text: chat.unread ? "标记为已读" : "标记为未读",
    icon: chat.unread ? EyeOff : Eye, key: shortcut("U", true) };
  const archive = { id: "archive", text: chat.archived ? "取消归档" : "归档",
    icon: chat.archived ? ArchiveRestore : Archive, key: shortcut("A", true) };
  const remove = { id: "delete", text: header ? "Delete" : "永久删除", icon: Trash2, danger: true };
  const copy = { id: "copy", text: "复制", icon: Copy, children: [
    { id: "copyLink", text: "复制深度链接", icon: Link2 },
    { id: "copyMarkdown", text: "复制为 Markdown", icon: FileText },
    { id: "copyId", text: "复制会话 ID", icon: Hash },
    { id: "copyWorkingDirectory", text: "复制工作目录", icon: Folder },
  ] };
  const newWindow = { id: "openWindow", text: "在新窗口中打开", icon: AppWindow };
  if (header) return [[rename, pin, copy,
    { id: "open", text: "打开方式", icon: ArrowUpRight, children: [newWindow, ...(openTargets.length
      ? openTargets.map(target => ({ id: "openTarget", text: target.label, payload: { target: target.id } }))
      : [{ id: "showInFinder", text: mac ? "在 Finder 中显示" : "在文件管理器中显示", icon: Folder }])] }, archive, remove]];
  return [
    [rename, pin, unread, { id: "sections", text: "分区", icon: List, children: [
      { id: "moveSection", text: "默认分区",
        selected: !chat.sectionId && !chat.pinned, payload: { sectionId: null } },
      ...sections.map(section => ({ id: "moveSection", text: section.name,
        selected: section.id === chat.sectionId && !chat.pinned, payload: { sectionId: section.id } })),
      { id: "newSection", text: "新建分区…", icon: FolderPlus },
    ] }, ...(projects.length ? [{ id: "projects", text: "移至项目", icon: Folder, children: [
      { id: "moveProject", text: "不加入项目", selected: !chat.projectId, payload: { projectId: null } },
      ...projects.map(project => ({ id: "moveProject", text: project.name,
        selected: project.id === chat.projectId, payload: { projectId: project.id } })),
    ] }] : [])],
    [{ id: "share", text: "分享", icon: Upload }, copy],
    [newWindow], [archive, remove],
  ];
}

export function ChatActionMenu({ chat, sections = [], projects = [], openTargets = [], anchor, variant, onAction, onClose }) {
  const header = variant === "header";
  return <ActionMenu label={header ? "更多聊天操作" : "聊天快捷菜单"}
    groups={menuGroups(chat, sections, projects, header, openTargets)} anchor={anchor} variant={variant} onClose={onClose}
    onAction={(item, rect) => onAction(item.id, chat, item.id === "share"
      ? { x: Math.round(rect.left), y: Math.round(rect.bottom) } : item.payload)}/>;
}
