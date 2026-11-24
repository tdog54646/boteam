import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { errorText, IconButton, Spinner } from "./ui";
import SubagentGlyph from "./SubagentGlyph";
import "./subagents.css";

export const agentStatus = {
  pendingInit: "等待启动", running: "运行中", dispatched: "已派发", unconfirmed: "状态待确认",
  completed: "已完成", interrupted: "已中断", errored: "失败",
  shutdown: "已关闭", notFound: "未找到",
};
export const finishedAgentStates = new Set(["completed", "interrupted", "errored", "shutdown", "notFound"]);
const active = new Set(["pendingInit", "running"]);
const awaiting = new Set(["dispatched", "unconfirmed"]);
const afterParent = { done: "unconfirmed", interrupted: "interrupted", failed: "errored" };
const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity CLI" };

export function listSubagents(chatId, tasks, bots, accounts) {
  const agents = new Map();
  if (!chatId) return [];
  const botNames = new Map(bots.map(bot => [bot.id, bot.name]));
  const providers = new Map(accounts.map(account => [account.id, account.provider]));
  for (const task of tasks) {
    if (task.chatId !== chatId) continue;
    for (const { agent, observedAt } of task.events || []) {
      if (!agent?.id || !Object.hasOwn(agentStatus, agent.status)) continue;
      const key = JSON.stringify([task.botId, agent.id]);
      const previous = agents.get(key);
      const status = active.has(agent.status) ? afterParent[task.status] || agent.status : agent.status;
      agents.set(key, {
        ...previous, ...agent, key, status, botId: task.botId,
        recencyAtMs: Number.isFinite(observedAt) ? observedAt : (Date.parse(task.createdAt) || 0),
        botName: botNames.get(task.botId), provider: providers.get(task.accountId) || previous?.provider,
      });
    }
  }
  return [...agents.values()].map((agent, index) => ({
    ...agent, name: agent.name || "子智能体 " + (index + 1), avatarSeed: agent.nativeThreadId || agent.id,
  })).sort((a, b) => b.recencyAtMs - a.recencyAtMs);
}

function State({ agent }) {
  return <span className="subagent-state" data-state={agent.status}>
    <i aria-hidden="true" />{agentStatus[agent.status]}
  </span>;
}

function AgentTranscript({ agent, chatId, invoke, activeTab, back }) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const view = useRef(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    if (!activeTab) return;
    let disposed = false;
    let busy = false;
    let pending = false;
    async function refresh() {
      if (disposed) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const entries = await invoke("agentTranscript", { chatId, botId: agent.botId, agentId: agent.id });
        if (!disposed) setResult(previous => {
          const saved = previous?.entries;
          const same = saved?.length === entries.length && entries.every((entry, index) =>
            entry.id === saved[index].id && entry.role === saved[index].role && entry.text === saved[index].text);
          return same ? previous : { entries };
        });
      } catch (error) {
        if (!disposed) setResult({ error: errorText(error) });
      } finally {
        busy = false;
        if (pending) { pending = false; void refresh(); }
      }
    }
    void refresh();
    const unsubscribe = window.boteam?.subscribe(refresh);
    return () => { disposed = true; unsubscribe?.(); };
  }, [agent.id, agent.botId, chatId, invoke, activeTab, retry]);
  useLayoutEffect(() => {
    if (stickToBottom.current && view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [result]);
  const provider = providerNames[agent.provider];
  const model = [agent.model, agent.effort].filter(Boolean).join(" · ");
  const details = [provider, model].filter(Boolean).join(" · ");
  const waiting = active.has(agent.status);
  const noReply = result?.entries && !result.entries.some(entry => entry.role === "assistant");
  const emptyReply = agent.nativeThreadId && agent.provider === "antigravity" ? "已读取原生子会话，当前没有正文回复。" : {
    dispatched: "CLI 已确认派发，尚未提供子智能体会话或完成状态。",
    unconfirmed: "主任务已结束，暂未收到子智能体回复。",
  }[agent.status] || "此任务没有可预览的子智能体回复。";
  return <>
    <header className="subagent-heading">
      <IconButton icon={ArrowLeft} label="返回子智能体列表" onClick={back} />
      <SubagentGlyph seed={agent.avatarSeed} size={24} />
      <div className="subagent-identity">
        <h2 title={agent.name}>{agent.name}</h2>
        {details && <small title={details}>{details}</small>}
      </div>
      <State agent={agent} />
    </header>
    <div className="subagent-transcript" ref={view} role="region" aria-label="子智能体会话"
      onScroll={event => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 64;
      }}>
      {!result ? <p className="subagent-hint" role="status"><Spinner size={14} /> 正在读取子智能体会话</p> :
        result.error ? <p className="subagent-hint" role="alert">{result.error} <button type="button"
          className="text-btn" onClick={() => { setResult(null); setRetry(n => n + 1); }}>重试</button></p> :
        <>
          {result.entries.map(entry => entry.role === "activity" ?
            <p className="subagent-activity" key={entry.id}>{entry.text}</p> :
            <article className="subagent-entry" key={entry.id} data-role={entry.role}>
              <h3>{entry.role === "user" ? "分派消息" : "子智能体"}</h3>
              <div className="markdown"><ReactMarkdown
                components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt || "图片"}</span> }}>
                {entry.text}
              </ReactMarkdown></div>
            </article>)}
          {waiting && noReply &&
            <p className="subagent-hint" role="status">正在等待子智能体输出</p>}
          {!waiting && noReply && <p className="subagent-hint">{emptyReply}</p>}
        </>}
    </div>
  </>;
}

export function SubagentsPanel({ agents, agentKey, select, chatId, invoke, activeTab }) {
  const agent = agents.find(item => item.key === agentKey);
  if (agent) return <AgentTranscript key={agent.key} agent={agent} chatId={chatId} invoke={invoke} activeTab={activeTab}
    back={() => select(null)} />;
  const groups = [
    { title: "进行中", items: agents.filter(item => active.has(item.status)) },
    { title: "待确认", items: agents.filter(item => awaiting.has(item.status)) },
    { title: "已结束", items: agents.filter(item => !active.has(item.status) && !awaiting.has(item.status)) },
  ].filter(group => group.items.length);
  return <div className="subagent-list" aria-label="子智能体列表">
    {!groups.length && <p className="subagent-hint">当前对话暂无子智能体记录。</p>}
    {groups.map(({ title, items }) => (
      <section key={title} aria-label={title}>
        <h2>{title} <span>{items.length}</span></h2>
        {items.map(item => <button type="button" key={item.key} className="subagent-row" onClick={() => select(item.key)}>
          <SubagentGlyph seed={item.avatarSeed} size={24} />
          <span className="subagent-title"><strong>{item.name}</strong>
            {(item.botName || item.provider) && <small>{[providerNames[item.provider], item.botName].filter(Boolean).join(" · ")}</small>}
          </span>
          <State agent={item} /><ChevronRight size={13} aria-hidden="true" />
        </button>)}
      </section>
    ))}
  </div>;
}
