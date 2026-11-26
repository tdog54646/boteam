import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, Copy } from "lucide-react";
import { fileBasename } from "../desktop/file-preview-rules.mjs";
import { extractRichMarkdownArtifacts, normalizeToolEvent, ToolActivityCard } from "./Conversation";
import { EndResourceCard } from "./FilePreviewView";
import { MarkdownContent } from "./MarkdownContent";
import SubagentGlyph from "./SubagentGlyph";
import { errorText, IconButton, Spinner } from "./ui";
import "./conversation.css";
import "./subagents.css";

export const agentStatus = {
  pendingInit: "等待启动",
  running: "运行中",
  dispatched: "已派发",
  unconfirmed: "状态待确认",
  completed: "已完成",
  interrupted: "已中断",
  errored: "失败",
  shutdown: "已关闭",
  notFound: "未找到",
};
export const finishedAgentStates = new Set(["completed", "interrupted", "errored", "shutdown", "notFound"]);
const active = new Set(["pendingInit", "running"]);
const awaiting = new Set(["dispatched", "unconfirmed"]);
const afterParent = { done: "unconfirmed", interrupted: "interrupted", failed: "errored" };
const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity CLI" };

export function listSubagents(chatId, tasks, bots, accounts) {
  const agents = new Map();
  if (!chatId) return [];
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const providers = new Map(accounts.map((account) => [account.id, account.provider]));
  for (const task of tasks) {
    if (task.chatId !== chatId) continue;
    for (const { agent, observedAt } of task.events || []) {
      if (!agent?.id || !Object.hasOwn(agentStatus, agent.status)) continue;
      const key = JSON.stringify([task.botId, agent.id]);
      const previous = agents.get(key);
      const status = active.has(agent.status) ? afterParent[task.status] || agent.status : agent.status;
      agents.set(key, {
        ...previous,
        ...agent,
        key,
        status,
        botId: task.botId,
        recencyAtMs: Number.isFinite(observedAt) ? observedAt : Date.parse(task.createdAt) || 0,
        botName: botNames.get(task.botId),
        provider: providers.get(task.accountId) || previous?.provider,
      });
    }
  }
  return [...agents.values()]
    .map((agent, index) => ({
      ...agent,
      name: agent.name || "子智能体 " + (index + 1),
      avatarSeed: agent.nativeThreadId || agent.id,
    }))
    .sort((a, b) => b.recencyAtMs - a.recencyAtMs);
}

function State({ agent }) {
  return (
    <span className="subagent-state" data-state={agent.status}>
      <i aria-hidden="true" />
      {agentStatus[agent.status]}
    </span>
  );
}

function liveSubagentHeadline(toolEvents) {
  const latest = [...toolEvents].reverse().find((ev) => ev.status === "running") || toolEvents.at(-1);
  if (!latest) return "正在思考";
  if (latest.category === "read" || latest.category === "search") return "正在读取文件";
  if (latest.category === "command" || latest.kind === "command") return "正在运行命令";
  if (latest.category === "edit" || latest.kind === "fileChange") return "正在编辑文件";
  if (latest.category === "web" || latest.kind === "webSearch") return "正在搜索网页";
  return "正在调用工具";
}

function isReportSignoff(text, reportText) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed.length > 220) return false;
  if (reportText && reportText.length < trimmed.length * 2) return false;
  return /send_message|(?:已|已经).*(?:通过|将|把|完成).*(?:发送|回报|返回|提交|汇报|转交)/i.test(trimmed);
}

export function buildSubagentTurns(entries, agentRunning) {
  const rawTurns = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    if (entry.role === "user") {
      rawTurns.push({ id: entry.id, userEntry: entry, items: [] });
    } else {
      if (!rawTurns.length) {
        rawTurns.push({ id: "turn-0", userEntry: null, items: [] });
      }
      rawTurns.at(-1).items.push(entry);
    }
  }

  return rawTurns.map((turn, turnIndex) => {
    const isLastTurn = turnIndex === rawTurns.length - 1;
    const turnRunning = isLastTurn && agentRunning;
    const items = turn.items.filter((item, idx, arr) => {
      if (
        item?.role === "activity" &&
        item.text === "发送消息" &&
        arr[idx + 1]?.role === "assistant" &&
        String(arr[idx + 1]?.id || "").includes(":report:")
      ) {
        return false;
      }
      return true;
    });
    const timelineBlocks = [];
    const allToolEvents = [];
    const knownFiles = new Set();
    const changedFilesMap = new Map();
    let pendingTools = [];
    const finalEntries = [];

    const flushTools = () => {
      if (pendingTools.length) {
        timelineBlocks.push({
          type: "tools",
          key: `${turn.id}-tools-${timelineBlocks.length}`,
          events: pendingTools,
        });
        pendingTools = [];
      }
    };

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const hasLaterItems = i < items.length - 1;
      if (item.role === "activity") {
        const isLiveTail = turnRunning && !hasLaterItems;
        const norm = normalizeToolEvent({
          callId: item.id,
          text: item.text,
          ...(item.meta || {}),
          status: isLiveTail ? "running" : item.meta?.status || "completed",
        });
        pendingTools.push(norm);
        allToolEvents.push(norm);
        if (norm.filePath) {
          knownFiles.add(norm.filePath);
          knownFiles.add(fileBasename(norm.filePath));
        }
        if (Array.isArray(norm.files)) {
          for (const f of norm.files) {
            if (!f?.path) continue;
            knownFiles.add(f.path);
            knownFiles.add(fileBasename(f.path));
            if (norm.kind === "fileChange") {
              if (f.kind === "deleted") changedFilesMap.delete(f.path);
              else changedFilesMap.set(f.path, { path: f.path, action: f.kind || "modified" });
            }
          }
        }
      } else if (item.role === "assistant") {
        flushTools();
        const hasLaterActivity = items.slice(i + 1).some((later) => later.role === "activity");
        if (hasLaterActivity) {
          timelineBlocks.push({
            type: "commentary",
            key: item.id,
            text: item.text,
          });
        } else {
          finalEntries.push(item);
        }
      }
    }
    flushTools();

    const reportEntry = finalEntries.find((entry) => String(entry.id || "").includes(":report:"));
    const filteredFinals = reportEntry
      ? finalEntries.filter(
          (entry) => entry === reportEntry || !isReportSignoff(entry.text, reportEntry.text),
        )
      : finalEntries;
    const finalText = filteredFinals
      .map((entry) => String(entry.text || "").trim())
      .filter(Boolean)
      .join("\n\n");

    const artifactCandidates = [...changedFilesMap.values()];
    if (finalText) {
      for (const linked of extractRichMarkdownArtifacts(finalText)) {
        const exists = artifactCandidates.some(
          (c) => c.path === linked.path || fileBasename(c.path) === fileBasename(linked.path),
        );
        if (!exists) artifactCandidates.push(linked);
      }
    }

    return {
      id: turn.id,
      userEntry: turn.userEntry,
      isLastTurn,
      turnRunning,
      timelineBlocks,
      allToolEvents,
      finalText,
      knownFiles,
      outputFiles: artifactCandidates.slice(0, 6),
    };
  });
}

function SubagentTurnView({
  turn,
  agent,
  emptyReply,
  waiting,
  onOpenFile,
  onOpenUrl,
  onOpenChatLink,
}) {
  const hasIntermediateSteps = turn.timelineBlocks.length > 0;
  const [stepsOpen, setStepsOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const stepsRegionId = useId();

  async function copyReply() {
    if (!turn.finalText) return;
    try {
      await navigator.clipboard.writeText(turn.finalText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  const toolCount = turn.allToolEvents.length;
  const showTurnBody =
    hasIntermediateSteps ||
    Boolean(turn.finalText) ||
    turn.turnRunning ||
    (turn.isLastTurn && (waiting || Boolean(emptyReply)));

  return (
    <div className="subagent-turn-group">
      {turn.userEntry && (
        <article className="message user-message subagent-user-message">
          <div className="user-bubble">
            <MarkdownContent
              text={turn.userEntry.text}
              onOpenChatLink={onOpenChatLink}
              onOpenFile={onOpenFile}
              onOpenUrl={onOpenUrl}
              knownFiles={turn.knownFiles}
            />
          </div>
        </article>
      )}

      {showTurnBody && (
        <article className="message bot-message subagent-bot-message">
          <div className="codex-turn">
            {turn.turnRunning ? (
              <div className="turn-live-bar">
                <span className="turn-live-status">
                  <span className="codex-shimmer">{liveSubagentHeadline(turn.allToolEvents)}</span>
                </span>
              </div>
            ) : turn.isLastTurn && agent.status === "interrupted" ? (
              hasIntermediateSteps ? (
                <button
                  type="button"
                  className="turn-duration-toggle is-interrupted"
                  aria-expanded={stepsOpen}
                  aria-controls={stepsRegionId}
                  onClick={() => setStepsOpen((v) => !v)}
                >
                  <span>已中断{toolCount ? ` · ${toolCount} 项操作` : ""}</span>
                  <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
                </button>
              ) : (
                <div className="turn-duration-static is-interrupted">已中断</div>
              )
            ) : turn.isLastTurn && agent.status === "errored" ? (
              hasIntermediateSteps ? (
                <button
                  type="button"
                  className="turn-duration-toggle is-failed"
                  aria-expanded={stepsOpen}
                  aria-controls={stepsRegionId}
                  onClick={() => setStepsOpen((v) => !v)}
                >
                  <CircleAlert size={13} />
                  <span>运行失败{toolCount ? ` · ${toolCount} 项操作` : ""}</span>
                  <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
                </button>
              ) : (
                <div className="turn-duration-static is-failed">
                  <CircleAlert size={13} />
                  <span>运行失败</span>
                </div>
              )
            ) : hasIntermediateSteps ? (
              <button
                type="button"
                className="turn-duration-toggle"
                aria-expanded={stepsOpen}
                aria-controls={stepsRegionId}
                onClick={() => setStepsOpen((v) => !v)}
              >
                <span>执行过程{toolCount ? ` · ${toolCount} 项操作` : ""}</span>
                <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
              </button>
            ) : null}

            {hasIntermediateSteps && (
              <div
                id={stepsRegionId}
                className={`turn-steps-collapse ${stepsOpen || turn.turnRunning ? "is-open" : ""}`}
              >
                <div className="turn-steps-inner">
                  {turn.timelineBlocks.map((block) => {
                    if (block.type === "commentary") {
                      return (
                        <div className="turn-commentary" key={block.key}>
                          <MarkdownContent
                            text={block.text}
                            onOpenChatLink={onOpenChatLink}
                            onOpenFile={onOpenFile}
                            onOpenUrl={onOpenUrl}
                            knownFiles={turn.knownFiles}
                          />
                        </div>
                      );
                    }
                    if (block.type === "tools") {
                      return (
                        <ToolActivityCard
                          key={block.key}
                          events={block.events}
                          taskRunning={turn.turnRunning}
                          onOpenFile={onOpenFile}
                          onOpenUrl={onOpenUrl}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            )}

            {turn.finalText && (
              <div className="turn-final-answer">
                <MarkdownContent
                  text={turn.finalText}
                  onOpenChatLink={onOpenChatLink}
                  onOpenFile={onOpenFile}
                  onOpenUrl={onOpenUrl}
                  knownFiles={turn.knownFiles}
                />
              </div>
            )}

            {turn.outputFiles.length > 0 && (
              <div className="end-resource-list" aria-label="生成与更新的文件">
                {turn.outputFiles.map((item) => (
                  <EndResourceCard
                    key={item.path}
                    filePath={item.path}
                    action={item.action}
                    onOpen={() => onOpenFile?.({ path: item.path })}
                  />
                ))}
              </div>
            )}

            {turn.isLastTurn && !turn.finalText && waiting && (
              <p className="subagent-hint" role="status">
                <span className="codex-shimmer">正在等待子智能体输出</span>
              </p>
            )}

            {turn.isLastTurn && !turn.finalText && !waiting && emptyReply && (
              <p className="subagent-hint">{emptyReply}</p>
            )}

            {turn.finalText && (
              <div className="codex-msg-actions">
                <button
                  type="button"
                  className="codex-action-icon"
                  aria-label={copied ? "已复制回复" : "复制回复"}
                  title={copied ? "已复制" : "复制"}
                  onClick={copyReply}
                >
                  {copied ? <Check size={13.5} /> : <Copy size={13.5} />}
                </button>
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}

function AgentTranscript({ agent, chatId, invoke, activeTab, open, back }) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const view = useRef(null);
  const isAgentActive = active.has(agent.status);
  const stickToBottom = useRef(isAgentActive);

  useEffect(() => {
    if (!activeTab) return;
    let disposed = false;
    let busy = false;
    let pending = false;
    async function refresh() {
      if (disposed) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        const entries = await invoke("agentTranscript", {
          chatId,
          botId: agent.botId,
          agentId: agent.id,
        });
        if (!disposed) {
          setResult((previous) => {
            const saved = previous?.entries;
            const same =
              saved?.length === entries.length &&
              entries.every(
                (entry, index) =>
                  entry.id === saved[index].id &&
                  entry.role === saved[index].role &&
                  entry.text === saved[index].text &&
                  JSON.stringify(entry.meta || null) === JSON.stringify(saved[index].meta || null),
              );
            return same ? previous : { entries };
          });
        }
      } catch (error) {
        if (!disposed) setResult({ error: errorText(error) });
      } finally {
        busy = false;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    }
    void refresh();
    const unsubscribe = window.boteam?.subscribe(refresh);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [agent.id, agent.botId, chatId, invoke, activeTab, retry]);

  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    if (stickToBottom.current && isAgentActive) {
      el.scrollTop = el.scrollHeight;
    }
    const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
    setShowScrollBottom(dist > 160);
  }, [result, isAgentActive]);

  const handleOpenFile = useCallback(
    (ref) => {
      if (!ref?.path) return;
      open?.({
        type: "file",
        botId: agent.botId,
        path: ref.path,
        line: ref.line ?? null,
        endLine: ref.endLine ?? null,
        allowWorkspaceAbsolute: true,
      });
    },
    [open, agent.botId],
  );

  const handleOpenUrl = useCallback(
    (url) => {
      if (!url) return;
      open?.({ type: "url", botId: agent.botId, url });
    },
    [open, agent.botId],
  );

  const handleOpenChatLink = useCallback(
    (url) => {
      invoke("openChatLink", { url }).catch(() => {});
    },
    [invoke],
  );

  const provider = providerNames[agent.provider];
  const model = [agent.model, agent.effort].filter(Boolean).join(" · ");
  const details = [provider, model].filter(Boolean).join(" · ");
  const waiting = active.has(agent.status);
  const entries = result?.entries || [];
  const noReply = result?.entries && !entries.some((entry) => entry.role === "assistant");
  const blockedOnApproval = entries.some(
    (entry) => entry.role === "activity" && entry.text.includes("等待权限确认"),
  );
  const emptyReply = blockedOnApproval
    ? "该子智能体因调用需交互授权的工具已挂起中断，后续由主会话接管。"
    : agent.nativeThreadId && agent.provider === "antigravity"
      ? "已读取原生子会话，当前没有正文回复。"
      : {
          dispatched: "CLI 已确认派发，尚未提供子智能体会话或完成状态。",
          unconfirmed: "主任务已结束，暂未收到子智能体回复。",
        }[agent.status] || "此任务没有可预览的子智能体回复。";

  const turns = useMemo(() => buildSubagentTurns(entries, waiting), [entries, waiting]);

  function jumpToBottom() {
    stickToBottom.current = true;
    setShowScrollBottom(false);
    view.current?.scrollTo({ top: view.current.scrollHeight, behavior: "smooth" });
  }

  return (
    <>
      <header className="subagent-heading">
        <IconButton icon={ArrowLeft} label="返回子智能体列表" onClick={back} />
        <SubagentGlyph seed={agent.avatarSeed} size={24} />
        <div className="subagent-identity">
          <h2 title={agent.name}>{agent.name}</h2>
          {details && <small title={details}>{details}</small>}
        </div>
        <State agent={agent} />
      </header>
      <div className="subagent-transcript-stage">
        <div
          className="subagent-transcript"
          ref={view}
          role="region"
          aria-label="子智能体会话"
          onScroll={(event) => {
            const el = event.currentTarget;
            const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
            stickToBottom.current = dist < 64;
            setShowScrollBottom(dist > 160);
          }}
        >
          {!result ? (
            <p className="subagent-hint" role="status">
              <Spinner size={14} /> 正在读取子智能体会话
            </p>
          ) : result.error ? (
            <p className="subagent-hint" role="alert">
              {result.error}{" "}
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setResult(null);
                  setRetry((n) => n + 1);
                }}
              >
                重试
              </button>
            </p>
          ) : turns.length > 0 ? (
            <div className="subagent-message-log">
              {turns.map((turn) => (
                <SubagentTurnView
                  key={turn.id}
                  turn={turn}
                  agent={agent}
                  emptyReply={noReply ? emptyReply : ""}
                  waiting={waiting}
                  onOpenFile={handleOpenFile}
                  onOpenUrl={handleOpenUrl}
                  onOpenChatLink={handleOpenChatLink}
                />
              ))}
            </div>
          ) : (
            <>
              {waiting && (
                <p className="subagent-hint" role="status">
                  <span className="codex-shimmer">正在等待子智能体输出</span>
                </p>
              )}
              {!waiting && <p className="subagent-hint">{emptyReply}</p>}
            </>
          )}
        </div>
        {showScrollBottom && (
          <button
            type="button"
            className="codex-float-scroll-btn conv-scroll-bottom"
            aria-label="回到底部"
            title="回到底部"
            onClick={jumpToBottom}
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>
    </>
  );
}

export function SubagentsPanel({ agents, agentKey, select, chatId, invoke, activeTab, open }) {
  const agent = agents.find((item) => item.key === agentKey);
  if (agent) {
    return (
      <AgentTranscript
        key={agent.key}
        agent={agent}
        chatId={chatId}
        invoke={invoke}
        activeTab={activeTab}
        open={open}
        back={() => select(null)}
      />
    );
  }
  const groups = [
    { title: "进行中", items: agents.filter((item) => active.has(item.status)) },
    { title: "待确认", items: agents.filter((item) => awaiting.has(item.status)) },
    { title: "已结束", items: agents.filter((item) => !active.has(item.status) && !awaiting.has(item.status)) },
  ].filter((group) => group.items.length);
  return (
    <div className="subagent-list" aria-label="子智能体列表">
      {!groups.length && <p className="subagent-hint">当前对话暂无子智能体记录。</p>}
      {groups.map(({ title, items }) => (
        <section key={title} aria-label={title}>
          <h2>
            {title} <span>{items.length}</span>
          </h2>
          {items.map((item) => (
            <button type="button" key={item.key} className="subagent-row" onClick={() => select(item.key)}>
              <SubagentGlyph seed={item.avatarSeed} size={24} />
              <span className="subagent-title">
                <strong>{item.name}</strong>
                {(item.botName || item.provider) && (
                  <small>{[providerNames[item.provider], item.botName].filter(Boolean).join(" · ")}</small>
                )}
              </span>
              <State agent={item} />
              <ChevronRight size={13} aria-hidden="true" />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
