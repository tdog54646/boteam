import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Asterisk, Bot, Check, ChevronDown, ChevronRight, Command, Ellipsis, FileText,
  Folder, GitBranch, Globe, Link2, Orbit, PanelRight, Plus, Search, Sparkle, Upload,
} from "lucide-react";
import { errorText, IconButton, Spinner } from "./ui";
import "./chat-toolbar.css";

const statusNames = {
  pendingInit: "等待启动", running: "运行中", completed: "已完成", interrupted: "已中断",
  errored: "失败", shutdown: "已关闭", notFound: "未找到",
};
const agentMarks = [Asterisk, Command, Sparkle, Orbit];
const noFiles = [];

function OverviewIcon({ size, strokeWidth }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" aria-hidden="true">
    <circle cx="5" cy="7" r="2.5" /><circle cx="5" cy="17" r="2.5" />
    <path d="M12 7h9M12 17h7" />
  </svg>;
}

function conversationActivity(messages, tasks, drafts) {
  const sources = new Map();
  const agents = new Map();
  const addFile = (file, messageId) => sources.set(file.id, {
    id: file.id, title: file.name, kind: file.kind === "folder" ? "folder" : "file", messageId,
  });
  function addUrl(raw, messageId) {
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
      sources.set(url.href, { id: url.href, kind: "url", title: url.host + url.pathname + url.search, url: url.href, messageId });
    } catch { /* Plain text may end in an incomplete address. */ }
  }
  for (const message of messages) {
    for (const file of message.attachments || []) addFile(file, message.id);
    for (const match of message.text?.matchAll(/https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef\])]+/gi) || []) {
      addUrl(match[0].replace(/[.,;:!?]+$/, ""), message.id);
    }
  }
  for (const task of tasks) {
    for (const [index, event] of (task.events || []).entries()) {
      if (event.agent) {
        const key = task.botId + "/" + event.agent.id;
        const previous = agents.get(key);
        agents.set(key, { ...previous, ...event.agent, key, messageId: task.messageId });
      }
      if (event.source?.url) addUrl(event.source.url, task.messageId);
      else if (event.source || ["搜索网页", "WebSearch", "WebFetch"].includes(event.text)) {
        const id = task.id + "/" + index;
        sources.set(id, { id, kind: "search", title: event.source?.title || "网页搜索", messageId: task.messageId });
      }
    }
  }
  for (const file of drafts) addFile(file, null);
  return { sources: [...sources.values()].reverse(), agents: [...agents.values()] };
}

function jumpToMessage(id) {
  const node = document.getElementById("message-" + id);
  node?.focus({ preventScroll: true });
  node?.scrollIntoView({ block: "center" });
}

function Overview({ id, chat, members, state, invoke, draft, pickSource, openWorkspace, dismiss }) {
  const [botId, setBotId] = useState(members[0]?.id);
  const member = members.find(bot => bot.id === botId) || members[0];
  const [changes, setChanges] = useState(null);
  const [failure, setFailure] = useState("");
  const [showChanges, setShowChanges] = useState(true);
  const [showAgents, setShowAgents] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const [filter, setFilter] = useState("");
  const jobs = useMemo(() => state.tasks.filter(t => t.chatId === chat.id), [state.tasks, chat.id]);
  const files = draft?.chatId === chat.id ? draft.files : noFiles;
  const activity = useMemo(() => conversationActivity(
    state.messages.filter(m => m.chatId === chat.id), jobs, files,
  ), [state.messages, jobs, chat.id, files]);
  const filteredSources = activity.sources.filter(s => s.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const complete = activity.agents.filter(a => a.status === "completed").length;
  const settled = jobs.filter(job => !["queued", "running", "approval"].includes(job.status)).length;
  useEffect(() => {
    if (!member || !showChanges) return;
    let current = true;
    setChanges(null);
    setFailure("");
    invoke("panelChanges", { chatId: chat.id, botId: member.id })
      .then(result => { if (current) setChanges(result); })
      .catch(e => { if (current) setFailure(errorText(e)); });
    return () => { current = false; };
  }, [chat.id, chat.initialProjectCwd, member?.id, invoke, showChanges, settled]);
  function sourceRow(source) {
    const Icon = { file: FileText, folder: Folder, url: Globe, search: Search }[source.kind];
    return (
      <button type="button" className="overview-row" key={source.id} title={source.title} onClick={() => {
        dismiss();
        if (source.url) openWorkspace({ type: "url", url: source.url });
        else if (source.kind === "file" || source.kind === "folder")
          openWorkspace({ type: "attachment", attachmentId: source.id, title: source.title });
        else if (source.messageId) jumpToMessage(source.messageId);
      }}>
        <Icon size={15} /><span>{source.title}</span>
      </button>
    );
  }
  return (
    <section id={id} className="chat-popover overview" aria-label="聊天概览" role="dialog">
      {allSources ? (
        <>
          <header className="overview-sources-head">
            <IconButton icon={ArrowLeft} label="返回聊天概览" onClick={() => { setAllSources(false); setFilter(""); }} />
            <strong>全部来源</strong>
          </header>
          <label className="overview-search"><Search size={15} /><input autoFocus type="search" placeholder="搜索来源" aria-label="搜索来源"
            value={filter} onChange={e => setFilter(e.target.value)} /></label>
          {filteredSources.map(sourceRow)}
          {!filteredSources.length && <p>没有匹配的来源</p>}
        </>
      ) : (
        <>
          <div className="overview-section">
            <div className="overview-label">
              <button type="button" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
                变更 {showChanges ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              {members.length > 1 && <select value={member?.id} aria-label="查看成员工作目录" onChange={e => setBotId(e.target.value)}>
                {members.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>}
            </div>
            {showChanges && (failure ? <p role="alert">{failure}</p> : !member ? <p>没有可用的工作目录</p> :
              !changes ? <p><Spinner size={13} /> 正在读取变更</p> :
              <button className="overview-row overview-repo" onClick={() => { dismiss(); openWorkspace({ type: "changes", botId: member.id }); }}
                title={changes.root}>
                <GitBranch size={15} /><span>{changes.repo ? [changes.repo, changes.branch].filter(Boolean).join(" · ") : "当前目录未使用 Git"}</span>
                {changes.repo && <small><b>+{changes.added}</b> <em>−{changes.removed}</em></small>}
              </button>)}
          </div>
          <div className="overview-section">
            <div className="overview-label">子智能体</div>
            {activity.agents.length ? <>
              <button className="overview-row" aria-expanded={showAgents} onClick={() => setShowAgents(!showAgents)}>
                <i className="overview-agent-marks" aria-hidden="true">{activity.agents.slice(0, 4).map((agent, index) => {
                  const Mark = agentMarks[index];
                  return <Mark key={agent.key} size={14} />;
                })}</i><span>{complete === activity.agents.length ? complete + " 个已完成" :
                  activity.agents.length + " 个子智能体 · " + complete + " 个已完成"}</span>
                {showAgents ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              {showAgents && activity.agents.map((a, i) => <button key={a.key} className="overview-row agent-detail"
                onClick={() => { dismiss(); jumpToMessage(a.messageId); }}>
                {a.status === "completed" ? <Check size={13} /> : <Bot size={13} />}
                <span>{a.name || "子智能体 " + (i + 1)}</span><small>{statusNames[a.status]}</small>
              </button>)}
            </> : <p>暂无子智能体记录</p>}
          </div>
          <div className="overview-section">
            <div className="overview-label">来源
              <IconButton icon={Plus} label="添加来源" disabled={draft?.chatId !== chat.id || !draft?.canPick}
                onClick={() => { dismiss(); pickSource(); }} />
            </div>
            {activity.sources.slice(0, 3).map(sourceRow)}
            {!activity.sources.length && <p>暂无来源</p>}
            {activity.sources.length > 0 && <button className="overview-row overview-all" onClick={() => setAllSources(true)}>
              <Link2 size={15} /><span>查看全部</span>
            </button>}
          </div>
        </>
      )}
    </section>
  );
}

export function ChatToolbar({ chat, draftChat, members, state, invoke, draft, pickSource, onChatMenu, onChatAction, menuOpen, workspaceVisible, toggleWorkspace, openWorkspace }) {
  const [popup, setPopup] = useState(null);
  const group = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  function dismiss(restoreFocus = false) {
    setPopup(null);
    if (restoreFocus) trigger.current?.focus();
  }
  function toggle(name, event) {
    trigger.current = event.currentTarget;
    setPopup(current => current === name ? null : name);
  }
  useEffect(() => {
    if (!popup) return;
    const panel = document.getElementById(id);
    panel?.querySelector("button:enabled")?.focus();
    const outside = event => { if (!group.current?.contains(event.target)) dismiss(); };
    const escape = event => { if (event.key === "Escape") { event.preventDefault(); dismiss(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [popup, id]);
  return (
    <div ref={group} className="chat-tools">
      {chat && <>
        <IconButton icon={Ellipsis} label="更多聊天操作" aria-haspopup="menu" aria-expanded={!!menuOpen}
          onClick={event => {
            dismiss();
            const anchor = event.currentTarget;
            const rect = anchor.getBoundingClientRect();
            onChatMenu(chat, { x: rect.right, y: rect.bottom, anchor }, "header");
          }} />
        <IconButton icon={Upload} label="分享聊天" onClick={event => {
          dismiss();
          const { left, bottom } = event.currentTarget.getBoundingClientRect();
          onChatAction("share", chat, { x: Math.round(left), y: Math.round(bottom) });
        }} />
      </>}
      {(chat || draftChat) && <IconButton icon={OverviewIcon} label="聊天概览" aria-haspopup="dialog" aria-expanded={popup === "overview"}
        aria-controls={popup === "overview" ? id : undefined} onClick={e => toggle("overview", e)} />}
      {!workspaceVisible && <IconButton icon={PanelRight} label="打开右侧栏" aria-expanded={false}
        onClick={() => { dismiss(); toggleWorkspace(); }} />}
      {popup === "overview" && (chat || draftChat) && <Overview id={id} chat={chat || draftChat} members={members} state={state} invoke={invoke}
        draft={draft} pickSource={pickSource} openWorkspace={openWorkspace} dismiss={dismiss} />}
    </div>
  );
}
