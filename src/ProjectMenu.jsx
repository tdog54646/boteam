import { useLanguage } from "./preferences";
import React from "react";
import { Archive, FolderOpen, FolderPlus, List, Pin, PinOff, Settings, X } from "lucide-react";
import { ActionMenu } from "./ActionMenu";

export function ProjectMenu({ project, sections, chats, anchor, onClose, invokeAction, open }) {
  const tr = useLanguage();
  const projectId = project.id;
  const chatIds = chats.filter(chat => chat.projectId === projectId && !chat.archived).map(chat => chat.id);
  function act(item) {
    switch (item.id) {
      case "pin":
        return invokeAction("setProjectPinned", { projectId, pinned: !project.pinned });
      case "edit":
        return open({ type: "project", id: projectId });
      case "move":
        return invokeAction("moveProjectToSection", { projectId, sectionId: item.payload.sectionId });
      case "openFolder":
        return invokeAction("revealProjectFolder", { projectId });
      case "archive":
        return open({ type: "projectAction", action: "archive", id: projectId, expectedChatIds: chatIds });
      case "section":
      case "remove":
        return open({ type: "projectAction", action: item.id, id: projectId });
    }
  }
  const destinations = [{ id: null, name: tr("默认项目", "Default project") }, ...sections].map(section => ({
    id: "move", text: section.name, payload: { sectionId: section.id },
    selected: !project.pinned && section.id === (project.sectionId ?? null),
  }));
  const groups = [
    [{ id: "pin", text: project.pinned ? tr("取消置顶", "Unpin") : tr("置顶", "Pin"), icon: project.pinned ? PinOff : Pin },
      { id: "edit", text: tr("编辑", "Edit"), icon: Settings }],
    [{ id: "sections", text: tr("分区", "Section"), icon: List, children: [...destinations, { id: "section", text: tr("新建分区…", "New section…"), icon: FolderPlus }] },
      { id: "openFolder", text: /Mac/i.test(navigator.platform) ? tr("在 Finder 中显示", "Show in Finder") : tr("在文件管理器中显示", "Show in file manager"), icon: FolderOpen, disabled: !project.folders.length }],
    [{ id: "archive", text: tr("归档聊天", "Archive chat"), icon: Archive, disabled: !chatIds.length }],
    [{ id: "remove", text: tr("移除项目", "Remove project"), icon: X }],
  ];
  return <ActionMenu variant="project" label={project.name + tr(" 的项目操作", " project actions")} groups={groups}
    anchor={anchor} onClose={onClose} onAction={act}/>;
}
