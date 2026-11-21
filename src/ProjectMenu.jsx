import React from "react";
import { Archive, FolderOpen, FolderPlus, List, Pin, PinOff, Settings, X } from "lucide-react";
import { ActionMenu } from "./ActionMenu";

export function ProjectMenu({ project, sections, chats, anchor, onClose, invokeAction, open }) {
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
  const destinations = [{ id: null, name: "默认项目" }, ...sections].map(section => ({
    id: "move", text: section.name, payload: { sectionId: section.id },
    selected: !project.pinned && section.id === (project.sectionId ?? null),
  }));
  const groups = [
    [{ id: "pin", text: project.pinned ? "取消置顶" : "置顶", icon: project.pinned ? PinOff : Pin },
      { id: "edit", text: "编辑", icon: Settings }],
    [{ id: "sections", text: "分区", icon: List, children: [...destinations, { id: "section", text: "新建分区…", icon: FolderPlus }] },
      { id: "openFolder", text: /Mac/i.test(navigator.platform) ? "在 Finder 中显示" : "在文件管理器中显示", icon: FolderOpen, disabled: !project.folders.length }],
    [{ id: "archive", text: "归档聊天", icon: Archive, disabled: !chatIds.length }],
    [{ id: "remove", text: "移除项目", icon: X }],
  ];
  return <ActionMenu variant="project" label={project.name + " 的项目操作"} groups={groups}
    anchor={anchor} onClose={onClose} onAction={act}/>;
}
