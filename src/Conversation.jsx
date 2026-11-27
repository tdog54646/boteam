import { useLanguage } from "./preferences";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileDiff,
  FileText,
  KeyRound,
  Paperclip,
  Plug,
  Quote,
  Search,
  ShieldCheck,
  Square,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { shouldOfferAccountReauth } from "../desktop/auth-errors.mjs";
import { linkedChatId } from "../desktop/chat-transfer.mjs";
import { classifyPreviewFile, fileBasename, parseFileReference } from "../desktop/file-preview-rules.mjs";
import { AttachmentPreview } from "./AttachmentPreview";
import { Composer } from "./Composer";
import { EndResourceCard } from "./FilePreviewView";
import { MarkdownContent } from "./MarkdownContent";
import { MessageNavigator } from "./MessageNavigator";
import { MessageQuote } from "./MessageQuote";
import SubagentGlyph, { subagentAccentColor } from "./SubagentGlyph";
import { Button, errorText, Notice, ProviderIcon } from "./ui";
import "./conversation.css";

const activeStatuses = ["queued", "running", "approval"];
const activeAgentStates = new Set(["pendingInit", "running"]);
const afterParentAgentState = {
  done: "unconfirmed",
  interrupted: "interrupted",
  failed: "errored",
};

const RICH_ARTIFACT_KINDS = new Set([
  "markdown",
  "html",
  "svg",
  "image",
  "pdf",
  "spreadsheet",
  "docx",
  "pptx",
  "ipynb",
  "tex",
  "mermaid",
  "audio",
  "video",
]);

const localTime = (s, tr) =>
  s && !Number.isNaN(Date.parse(s))
    ? new Date(s).toLocaleTimeString(tr("zh-CN", "en"), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return asNum;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export function formatCodexDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function useLiveTick(enabled) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

export function normalizeToolEvent(ev) {
  if (!ev) return { kind: "toolCall", category: "mcp", title: "工具调用", status: "completed" };
  const rawFiles = Array.isArray(ev.files)
    ? ev.files.map((f) => ({
        ...f,
        kind:
          f.kind ||
          (f.mode === "delete" ? "deleted" : f.mode === "add" ? "created" : "modified"),
      }))
    : undefined;
  const resolvedPath = ev.filePath || ev.path || undefined;
  const resolvedUrl = ev.url || ev.source?.url || undefined;
  const resolvedQuery = ev.query || ev.source?.title || undefined;

  if (ev.kind && ev.kind !== "meta") {
    const category =
      ev.category ||
      (ev.kind === "command"
        ? "command"
        : ev.kind === "webSearch"
          ? "web"
          : ev.kind === "fileChange"
            ? "edit"
            : ev.kind === "read" || ev.kind === "list" || ev.kind === "image"
              ? "read"
              : ev.kind === "search"
                ? "search"
                : ev.kind === "loadedTool"
                  ? "loaded"
                  : "mcp");
    const defaultTitle =
      ev.kind === "webSearch"
        ? resolvedQuery
          ? `已搜索网页：${resolvedQuery}`
          : resolvedUrl
            ? `已搜索网页：${resolvedUrl}`
            : ev.title || ev.text || "搜索网页"
        : ev.title || ev.text || ev.label || "工具调用";
    return {
      ...ev,
      category,
      ...(resolvedPath && { filePath: resolvedPath }),
      ...(resolvedUrl && { url: resolvedUrl }),
      ...(resolvedQuery && { query: resolvedQuery }),
      ...(rawFiles && { files: rawFiles }),
      title: defaultTitle,
      status: ev.status || "completed",
    };
  }

  const text = String(ev.text || "").trim();
  if (
    text.startsWith("执行命令 · ") ||
    text === "运行命令" ||
    text.startsWith("运行了命令") ||
    text.startsWith("等待权限确认 · 运行命令")
  ) {
    const cmd = text.startsWith("执行命令 · ") ? text.replace(/^执行命令\s*·\s*/, "").trim() : "";
    return {
      ...ev,
      kind: "command",
      category: "command",
      title: cmd || text || "运行命令",
      ...(cmd && { command: cmd }),
      status: text.startsWith("等待权限确认") ? "failed" : ev.status || "completed",
    };
  }
  if (
    text === "搜索网页" ||
    text === "读取网页" ||
    text.startsWith("网页搜索") ||
    text.startsWith("已搜索网页") ||
    text.startsWith("读取网页")
  ) {
    const q = text
      .replace(/^(?:网页搜索\s*·\s*|已搜索网页：?\s*|读取网页：?\s*|搜索网页|读取网页)/, "")
      .trim();
    const url = resolvedUrl || (/^https?:\/\//i.test(q) ? q : undefined);
    const query = resolvedQuery || (!url && q ? q : undefined);
    return {
      ...ev,
      kind: "webSearch",
      category: "web",
      title: query ? `已搜索网页：${query}` : url ? `读取网页：${url}` : text || "搜索网页",
      ...(url && { url }),
      ...(query && { query }),
      status: ev.status || "completed",
    };
  }
  if (
    text.startsWith("文件变更") ||
    text === "写入文件" ||
    text === "编辑文件" ||
    text === "修改文件" ||
    text.startsWith("创建文件") ||
    text.startsWith("修改文件")
  ) {
    return {
      ...ev,
      kind: "fileChange",
      category: "edit",
      ...(resolvedPath && { filePath: resolvedPath }),
      ...(rawFiles && { files: rawFiles }),
      title: text,
      status: ev.status || "completed",
    };
  }
  if (
    text.startsWith("读取") ||
    text.startsWith("查看") ||
    text.startsWith("列出") ||
    text.startsWith("搜索") ||
    text.startsWith("查找")
  ) {
    const isSearch = text.startsWith("搜索") || text.startsWith("查找");
    return {
      ...ev,
      kind: isSearch ? "search" : "read",
      category: isSearch ? "search" : "read",
      ...(resolvedPath && { filePath: resolvedPath }),
      title: text,
      status: ev.status || "completed",
    };
  }
  return {
    ...ev,
    kind: "toolCall",
    category: ev.category || "mcp",
    ...(resolvedPath && { filePath: resolvedPath }),
    title: text || "工具调用",
    status: ev.status || "completed",
  };
}

function summarizeToolGroup(events, taskRunning, tr) {
  const runningEv = taskRunning
    ? [...events].reverse().find((ev) => ev.status === "running")
    : null;
  if (runningEv) {
    switch (runningEv.category) {
      case "loaded":
        return { text: tr("正在加载工具", "Loading tools"), running: true };
      case "read":
      case "search":
        return { text: tr("正在读取文件", "Reading files"), running: true };
      case "command":
        return { text: tr("正在运行命令", "Running a command"), running: true };
      case "edit":
        return { text: tr("正在编辑文件", "Editing files"), running: true };
      case "web":
        return { text: tr("正在搜索网页", "Searching the web"), running: true };
      default:
        return { text: tr("正在调用工具", "Using a tool"), running: true };
    }
  }

  const seen = new Set();
  for (const ev of events) {
    if (ev.kind === "loadedTool" || ev.category === "loaded") seen.add("loaded");
    else if (ev.category === "read" || ev.category === "search") seen.add("read");
    else if (ev.kind === "command" || ev.category === "command") seen.add("command");
    else if (ev.kind === "fileChange" || ev.category === "edit") seen.add("edit");
    else if (ev.kind === "webSearch" || ev.category === "web") seen.add("web");
    else seen.add("mcp");
  }

  const ordered = [
    ["loaded", tr("加载了工具", "Loaded tools")],
    ["read", tr("读取文件", "Read files")],
    ["command", tr("运行了命令", "Ran commands")],
    ["edit", tr("编辑了文件", "Edited files")],
    ["web", tr("已搜索网页", "Searched the web")],
  ];
  const clauses = ordered.filter(([key]) => seen.has(key)).map(([, label]) => label);
  if (!clauses.length || (seen.has("mcp") && clauses.length === 0)) {
    clauses.push(tr("调用了工具", "Used tools"));
  }
  return { clauses, text: clauses.join(" "), running: false };
}

function liveTurnHeadline(task, resolvedAgents, toolEvents, tr) {
  if (!task) return tr("正在运行", "Running");
  if (task.status === "queued") return tr("等待运行", "Queued");
  if (task.status === "approval") {
    return task.approval?.kind === "questions" ? tr("等待回答", "Awaiting an answer") : tr("等待审批", "Awaiting approval");
  }
  if (resolvedAgents.some((a) => activeAgentStates.has(a.status))) {
    return tr("子智能体正在运行", "Subagents running");
  }
  const latestRunningTool = [...toolEvents].reverse().find((e) => e.status === "running");
  if (latestRunningTool) {
    if (latestRunningTool.category === "read" || latestRunningTool.category === "search") return tr("正在读取文件", "Reading files");
    if (latestRunningTool.category === "command" || latestRunningTool.kind === "command") return tr("正在运行命令", "Running a command");
    if (latestRunningTool.category === "edit" || latestRunningTool.kind === "fileChange") return tr("正在编辑文件", "Editing files");
    if (latestRunningTool.category === "web" || latestRunningTool.kind === "webSearch") return tr("正在搜索网页", "Searching the web");
    if (latestRunningTool.category === "loaded" || latestRunningTool.kind === "loadedTool") return tr("正在加载工具", "Loading tools");
    return tr("正在调用工具", "Using a tool");
  }
  return tr("正在思考", "Thinking");
}

export function extractRichMarkdownArtifacts(markdownText) {
  if (!markdownText || typeof markdownText !== "string") return [];
  const found = [];
  const linkRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = linkRe.exec(markdownText)) !== null) {
    const parsed = parseFileReference(m[2]);
    if (!parsed || parsed.line != null) continue;
    const spec = classifyPreviewFile(parsed.path);
    if (RICH_ARTIFACT_KINDS.has(spec.previewKind)) {
      found.push({ path: parsed.path, action: null });
    }
  }
  return found;
}

function isMetaTaskEvent(ev) {
  if (!ev) return false;
  if (ev.kind === "meta") return true;
  if (ev.kind || ev.callId || ev.command || ev.filePath || ev.files?.length || ev.url || ev.agent) {
    return false;
  }
  const raw = typeof ev.text === "string" ? ev.text : typeof ev.value === "string" ? ev.value : "";
  return /^(?:Antigravity 已采用 |模型 \S+.*思考强度 |(?:Codex|Claude|Antigravity) 原生命令 · )/.test(
    raw.trim(),
  );
}

function buildTurnModel(message, task) {
  const isRunning = Boolean(task && activeStatuses.includes(task.status));
  const rawSegments =
    Array.isArray(message?.segments) && message.segments.length > 0
      ? message.segments.filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0)
      : message?.text?.trim()
        ? [{ id: "seg-0", text: message.text }]
        : [];

  const allEvents = task?.events || [];
  const metaEvents = [];
  const agentMap = new Map();
  const agentFirstBucket = new Map();
  const bucketTools = new Map();

  const pushBucketItem = (bucket, item) => {
    const list = bucketTools.get(bucket) || [];
    list.push(item);
    bucketTools.set(bucket, list);
  };

  for (const ev of allEvents) {
    if (!ev) continue;
    if (isMetaTaskEvent(ev)) {
      metaEvents.push(ev);
      continue;
    }
    const bucket = Number.isInteger(ev.segment) && ev.segment >= 0 ? ev.segment : 0;
    if (ev.agent?.id) {
      const prev = agentMap.get(ev.agent.id);
      const rawStatus = ev.agent.status || prev?.status || "running";
      const resolvedStatus = activeAgentStates.has(rawStatus)
        ? afterParentAgentState[task?.status] || rawStatus
        : rawStatus;
      agentMap.set(ev.agent.id, {
        ...prev,
        ...ev.agent,
        status: resolvedStatus,
        avatarSeed: ev.agent.nativeThreadId || prev?.nativeThreadId || ev.agent.id,
      });
      if (!agentFirstBucket.has(ev.agent.id)) {
        agentFirstBucket.set(ev.agent.id, bucket);
        pushBucketItem(bucket, { type: "agent-placeholder", agentId: ev.agent.id });
      }
      continue;
    }
    pushBucketItem(bucket, { type: "tool", event: normalizeToolEvent(ev) });
  }

  let agentIndex = 0;
  for (const [id, agent] of agentMap) {
    agentIndex += 1;
    agentMap.set(id, {
      ...agent,
      name: agent.name || `子智能体 ${agentIndex}`,
      agentKey: task ? JSON.stringify([task.botId, id]) : id,
    });
  }

  const maxEventBucket = bucketTools.size ? Math.max(...bucketTools.keys()) : -1;
  const hasTrailingEvents = maxEventBucket >= rawSegments.length;

  // Determine which segment is the final response vs intermediate commentary.
  let commentaryCount = 0;
  let finalSegment = null;
  if (rawSegments.length > 0) {
    if (hasTrailingEvents) {
      commentaryCount = rawSegments.length;
    } else {
      commentaryCount = Math.max(0, rawSegments.length - 1);
      finalSegment = rawSegments[rawSegments.length - 1];
    }
  }

  const buildBucketBlocks = (bucketIdx) => {
    const rawItems = bucketTools.get(bucketIdx) || [];
    const blocks = [];
    let pendingAgents = [];
    let pendingTools = [];

    const flushAgents = () => {
      if (pendingAgents.length) {
        blocks.push({ type: "agents", agents: pendingAgents });
        pendingAgents = [];
      }
    };
    const flushTools = () => {
      if (pendingTools.length) {
        blocks.push({ type: "tools", events: pendingTools });
        pendingTools = [];
      }
    };

    for (const item of rawItems) {
      if (item.type === "agent-placeholder") {
        flushTools();
        const resolved = agentMap.get(item.agentId);
        if (resolved) pendingAgents.push(resolved);
      } else if (item.type === "tool") {
        flushAgents();
        pendingTools.push(item.event);
      }
    }
    flushAgents();
    flushTools();
    return blocks;
  };

  const timelineBlocks = [];
  const maxSlot = Math.max(commentaryCount, maxEventBucket);
  for (let slot = 0; slot <= maxSlot; slot += 1) {
    for (const blk of buildBucketBlocks(slot)) {
      timelineBlocks.push({ ...blk, key: `b-${slot}-${timelineBlocks.length}` });
    }
    if (slot < commentaryCount && rawSegments[slot]) {
      timelineBlocks.push({
        type: "commentary",
        key: rawSegments[slot].id || `seg-${slot}`,
        text: rawSegments[slot].text,
      });
    }
  }

  // Collect known workspace files & generated/modified output cards.
  const knownFiles = new Set();
  const changedFilesMap = new Map();
  const allToolEvents = [];

  for (const ev of allEvents) {
    if (!ev || ev.agent || isMetaTaskEvent(ev)) continue;
    const norm = normalizeToolEvent(ev);
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
  }

  const artifactCandidates = [...changedFilesMap.values()];
  if (finalSegment?.text) {
    for (const linked of extractRichMarkdownArtifacts(finalSegment.text)) {
      const exists = artifactCandidates.some(
        (c) => c.path === linked.path || fileBasename(c.path) === fileBasename(linked.path),
      );
      if (!exists) artifactCandidates.push(linked);
    }
  }

  return {
    isRunning,
    timelineBlocks,
    finalSegment,
    metaEvents,
    resolvedAgents: [...agentMap.values()],
    allToolEvents,
    knownFiles,
    outputFiles: artifactCandidates.slice(0, 6),
    totalChangedFiles: changedFilesMap.size,
  };
}

function SubagentBatchRow({ agents, onSelectAgent }) {
  const tr = useLanguage();
  const anyActive = agents.some((a) => activeAgentStates.has(a.status));
  const anyFailed = !anyActive && agents.some((a) => a.status === "errored" || a.status === "interrupted");
  const statusLabel = anyActive ? tr("正在运行", "Running") : anyFailed ? tr("已结束", "Finished") : tr("已完成", "Completed");

  return (
    <div className="codex-subagent-row">
      <span className="codex-subagent-glyphs" aria-hidden="true">
        {agents.slice(0, 5).map((agent) => (
          <SubagentGlyph key={agent.id} seed={agent.avatarSeed} size={16} />
        ))}
      </span>
      <span className="codex-subagent-copy">
        {agents.map((agent, idx) => {
          const isLast = idx === agents.length - 1;
          const isSecondLast = idx === agents.length - 2;
          const sep = !isLast ? (isSecondLast ? tr("和", " and ") : "、") : "";
          return (
            <React.Fragment key={agent.id}>
              <button
                type="button"
                className="codex-agent-link"
                style={{ "--agent-accent": subagentAccentColor(agent.avatarSeed) }}
                onClick={() => onSelectAgent?.(agent.agentKey)}
              >
                {agent.name}
              </button>
              {sep && <span className="codex-subagent-sep">{sep}</span>}
            </React.Fragment>
          );
        })}
        <span className={`codex-subagent-status ${anyActive ? "codex-shimmer" : ""}`}>
          {" "}
          {statusLabel}
        </span>
      </span>
    </div>
  );
}

function ToolRowIcon({ event }) {
  if (event.kind === "command" || event.category === "command") {
    return <SquareTerminal size={13.5} className="codex-tool-icon" aria-hidden="true" />;
  }
  if (event.kind === "webSearch" || event.category === "web" || event.category === "search") {
    return <Search size={13.5} className="codex-tool-icon" aria-hidden="true" />;
  }
  if (event.kind === "fileChange" || event.category === "edit") {
    return <FileDiff size={13.5} className="codex-tool-icon" aria-hidden="true" />;
  }
  if (event.category === "read") {
    return <FileText size={13.5} className="codex-tool-icon" aria-hidden="true" />;
  }
  return <Plug size={13.5} className="codex-tool-icon" aria-hidden="true" />;
}

function singleLineCommand(cmd) {
  return String(cmd || "")
    .replace(/\s*\n+\s*/g, "; ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function ToolActivityCard({ events, taskRunning, onOpenFile, onOpenUrl }) {
  const tr = useLanguage();
  const [open, setOpen] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);
  const listRef = useRef(null);
  const stickBottom = useRef(true);
  const [overflowState, setOverflowState] = useState({ top: false, bottom: false });
  const summary = useMemo(() => summarizeToolGroup(events, taskRunning, tr), [events, taskRunning, tr]);

  const updateScrollShadows = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 8;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 18;
    stickBottom.current = !bottom;
    setOverflowState((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickBottom.current && taskRunning) {
      el.scrollTop = el.scrollHeight;
    }
    updateScrollShadows();
  }, [events.length, taskRunning, open, updateScrollShadows]);

  function scrollToLatest() {
    const el = listRef.current;
    if (!el) return;
    stickBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="codex-tool-group">
      <button
        type="button"
        className="codex-tool-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench size={13.5} className="codex-wrench-icon" aria-hidden="true" />
        <span className={`codex-tool-summary ${summary.running ? "codex-shimmer" : ""}`}>
          {summary.clauses
            ? summary.clauses.map((clause, i) => (
                <span key={clause} className="codex-summary-clause">
                  {clause}
                  {i < summary.clauses.length - 1 ? "" : ""}
                </span>
              ))
            : summary.text}
        </span>
        <ChevronDown size={13.5} className={`turn-chevron ${open ? "is-open" : ""}`} aria-hidden="true" />
      </button>

      <div className={`codex-tool-collapse ${open ? "is-open" : ""}`}>
        <div className="codex-tool-collapse-inner">
          <div
            className={`codex-tool-body-wrap ${overflowState.top ? "fade-top" : ""} ${overflowState.bottom ? "fade-bottom" : ""}`}
          >
            <div className="codex-tool-scroll" ref={listRef} onScroll={updateScrollShadows}>
              {events.map((ev, idx) => {
                const key = ev.callId || `ev-${idx}`;
                const singleFile =
                  ev.filePath || (ev.files?.length === 1 && ev.files[0].kind !== "deleted" ? ev.files[0].path : null);
                const hasDrawer = Boolean(
                  !singleFile && !ev.url && (ev.command || ev.output || (ev.files && ev.files.length > 1)),
                );
                const interactive = Boolean(singleFile || ev.url || hasDrawer);
                const isRowExpanded = expandedRow === key;

                const rowLabel =
                  ev.kind === "command" && ev.command
                    ? singleLineCommand(ev.command)
                    : ev.kind === "webSearch" && ev.url
                      ? tr(`已搜索网页：${ev.url}`, `Searched the web for ${ev.url}`)
                      : ev.title || ev.text || tr("工具调用", "Tool call");

                const diffTotals =
                  ev.kind === "fileChange" && Array.isArray(ev.files)
                    ? ev.files.reduce(
                        (acc, f) => ({
                          added: acc.added + (f.added || 0),
                          removed: acc.removed + (f.removed || 0),
                        }),
                        { added: 0, removed: 0 },
                      )
                    : null;

                function handleRowClick() {
                  if (singleFile) {
                    onOpenFile?.({ path: singleFile, line: ev.line || null });
                  } else if (ev.url) {
                    onOpenUrl?.(ev.url);
                  } else if (hasDrawer) {
                    setExpandedRow((cur) => (cur === key ? null : key));
                  }
                }

                return (
                  <div className="codex-tool-item" key={key}>
                    <button
                      type="button"
                      className={`codex-tool-row ${interactive ? "is-interactive" : ""} ${ev.status === "running" && taskRunning ? "is-running" : ""}`}
                      disabled={!interactive}
                      onClick={interactive ? handleRowClick : undefined}
                      title={rowLabel}
                    >
                      <ToolRowIcon event={ev} />
                      <span className={`codex-tool-label ${ev.status === "running" && taskRunning ? "codex-shimmer" : ""}`}>
                        {rowLabel}
                      </span>
                      {diffTotals && (diffTotals.added > 0 || diffTotals.removed > 0) && (
                        <span className="codex-diff-stat">
                          {diffTotals.added > 0 && <ins>+{diffTotals.added}</ins>}
                          {diffTotals.removed > 0 && <del>−{diffTotals.removed}</del>}
                        </span>
                      )}
                      {interactive && (
                        <ChevronRight
                          size={13}
                          className={`codex-tool-arrow ${isRowExpanded ? "is-open" : ""}`}
                          aria-hidden="true"
                        />
                      )}
                    </button>

                    {hasDrawer && isRowExpanded && (
                      <div className="codex-tool-drawer">
                        {ev.command && (
                          <pre className="codex-drawer-cmd">
                            <code>$ {ev.command}</code>
                          </pre>
                        )}
                        {ev.output && <pre className="codex-drawer-out">{ev.output}</pre>}
                        {ev.exitCode != null && ev.exitCode !== 0 && (
                          <div className="codex-drawer-exit">{tr("退出码", "Exit code")} {ev.exitCode}</div>
                        )}
                        {ev.files?.length > 1 && (
                          <div className="codex-drawer-files">
                            {ev.files.map((f) => (
                              <button
                                key={f.path}
                                type="button"
                                disabled={f.kind === "deleted"}
                                onClick={() => onOpenFile?.({ path: f.path })}
                              >
                                <FileText size={12} />
                                <span>{f.path}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {overflowState.bottom && (
              <button
                type="button"
                className="codex-tool-bottom-btn"
                aria-label={tr("滚动到最新工具记录", "Scroll to latest tool activity")}
                title={tr("滚动到底部", "Scroll to bottom")}
                onClick={scrollToLatest}
              >
                <ArrowDown size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NativeQuestions({ request, busy, submit }) {
  const tr = useLanguage();
  const [answers, setAnswers] = useState({});
  const [custom, setCustom] = useState({});
  const answer = (id, value) => setAnswers((previous) => ({ ...previous, [id]: value }));
  return (
    <form
      className="approval native-questions"
      onSubmit={(event) => {
        event.preventDefault();
        submit(answers);
      }}
    >
      {request.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label key={option.label}>
              <input
                type="radio"
                name={request.id + question.id}
                disabled={busy}
                checked={!custom[question.id] && answers[question.id] === option.label}
                onChange={() => {
                  setCustom((c) => ({ ...c, [question.id]: false }));
                  answer(question.id, option.label);
                }}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {question.isOther && question.options.length > 0 && (
            <label>
              <input
                type="radio"
                name={request.id + question.id}
                disabled={busy}
                checked={Boolean(custom[question.id])}
                onChange={() => {
                  setCustom((c) => ({ ...c, [question.id]: true }));
                  answer(question.id, "");
                }}
              />
              {tr("其他", "Other")}
            </label>
          )}
          {(!question.options.length || custom[question.id]) && (
            <textarea
              aria-label={question.question}
              className="snippet-input"
              rows={2}
              maxLength={10000}
              required
              disabled={busy}
              value={answers[question.id] || ""}
              onChange={(event) => answer(question.id, event.target.value)}
            />
          )}
        </fieldset>
      ))}
      <div className="actions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || request.questions.some((q) => !Object.hasOwn(answers, q.id) || !answers[q.id].trim())}
        >
          {tr("提交回答", "Submit answers")}
        </Button>
      </div>
    </form>
  );
}

function AssistantTurnBody({
  message,
  task,
  bot,
  account,
  group,
  canQuote,
  onQuote,
  invoke,
  onLogin,
  onError,
  openWorkspace,
}) {
  const tr = useLanguage();
  const [stepsOpen, setStepsOpen] = useState(true);
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taskActionError, setTaskActionError] = useState("");
  const stepsRegionId = useId();

  const model = useMemo(() => buildTurnModel(message, task), [message, task]);
  const { isRunning, timelineBlocks, finalSegment, metaEvents, resolvedAgents, allToolEvents, knownFiles, outputFiles, totalChangedFiles } =
    model;

  const nowMs = useLiveTick(isRunning);
  const startMs = toEpochMs(task?.startedAt) ?? toEpochMs(task?.createdAt);
  const endMs = isRunning
    ? nowMs
    : toEpochMs(task?.completedAt) ?? toEpochMs(message?.createdAt);
  const elapsedSeconds =
    startMs != null && endMs != null && endMs >= startMs ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;

  const hasIntermediateSteps = timelineBlocks.length > 0;
  const durationLabel =
    elapsedSeconds != null && (elapsedSeconds > 0 || hasIntermediateSteps || isRunning)
      ? formatCodexDuration(hasIntermediateSteps && !isRunning && elapsedSeconds === 0 ? 1 : elapsedSeconds)
      : "";

  const failed = task && ["failed", "interrupted"].includes(task.status);
  const botId = message?.botId || task?.botId || bot?.id;

  const handleOpenFile = useCallback(
    (ref) => {
      if (!ref?.path) return;
      openWorkspace?.({
        type: "file",
        path: ref.path,
        line: ref.line ?? null,
        endLine: ref.endLine ?? null,
        allowWorkspaceAbsolute: true,
        botId,
      });
    },
    [openWorkspace, botId],
  );

  const handleOpenUrl = useCallback(
    (url) => {
      if (!url) return;
      openWorkspace?.({ type: "url", url, botId });
    },
    [openWorkspace, botId],
  );

  const handleOpenChatLink = useCallback(
    (url) => {
      invoke("openChatLink", { url }).catch((err) => onError?.(errorText(err)));
    },
    [invoke, onError],
  );

  const handleSelectAgent = useCallback(
    (agentKey) => {
      openWorkspace?.({ type: "agents", agentKey, botId });
    },
    [openWorkspace, botId],
  );

  async function act(method, payload) {
    setTaskActionError("");
    setBusy(true);
    try {
      await invoke(method, payload);
    } catch (err) {
      setTaskActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyReply() {
    const raw = message?.text || finalSegment?.text || "";
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  const slashSuffix = task?.runSettings?.slashCommand ? ` · /${task.runSettings.slashCommand}` : "";
  const hasRuntimeMeta = Boolean(task?.tool || task?.identity || task?.verifiedKey || metaEvents.length);

  return (
    <div className="codex-turn">
      {group && (
        <div className="message-author">
          <ProviderIcon provider={account?.provider} size="small" />
          <strong>{message?.name || bot?.name || "Bot"}</strong>
          {message?.createdAt && <time dateTime={message.createdAt}>{localTime(message.createdAt, tr)}</time>}
        </div>
      )}

      {/* Turn elapsed / live status header */}
      {isRunning ? (
        <div className="turn-live-bar">
          <span className="turn-live-status">
            <span className="codex-shimmer">
              {liveTurnHeadline(task, resolvedAgents, allToolEvents, tr)}
              {slashSuffix}
            </span>
            {durationLabel && <span className="turn-live-timer">{durationLabel}</span>}
          </span>
          <button
            type="button"
            className="text-btn task-stop"
            onClick={() => act("cancel", { taskId: task.id })}
            disabled={busy}
            title={tr("停止任务", "Stop task")}
          >
            <Square size={10} />
            {tr("停止", "Stop")}
          </button>
        </div>
      ) : task?.status === "interrupted" ? (
        hasIntermediateSteps ? (
          <button
            type="button"
            className="turn-duration-toggle is-interrupted"
            aria-expanded={stepsOpen}
            aria-controls={stepsRegionId}
            onClick={() => setStepsOpen((v) => !v)}
          >
            <span>{durationLabel ? tr(`你在 ${durationLabel} 后停止了`, `You stopped this task after ${durationLabel}`) : tr("已中断", "Interrupted")}</span>
            <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
          </button>
        ) : (
          <div className="turn-duration-static is-interrupted">
            {durationLabel ? tr(`你在 ${durationLabel} 后停止了`, `You stopped this task after ${durationLabel}`) : tr("已中断", "Interrupted")}
          </div>
        )
      ) : task?.status === "failed" ? (
        hasIntermediateSteps ? (
          <button
            type="button"
            className="turn-duration-toggle is-failed"
            aria-expanded={stepsOpen}
            aria-controls={stepsRegionId}
            onClick={() => setStepsOpen((v) => !v)}
          >
            <CircleAlert size={13} />
            <span>{tr("运行失败", "Run failed")}{durationLabel ? ` · ${durationLabel}` : ""}</span>
            <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
          </button>
        ) : (
          <div className="turn-duration-static is-failed">
            <CircleAlert size={13} />
            <span>{tr("运行失败", "Run failed")}</span>
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
          <span>{durationLabel ? tr(`用时 ${durationLabel}`, `Took ${durationLabel}`) : tr("执行过程", "Activity")}</span>
          <ChevronDown size={13} className={`turn-chevron ${stepsOpen ? "is-open" : ""}`} aria-hidden="true" />
        </button>
      ) : durationLabel && elapsedSeconds >= 2 ? (
        <div className="turn-duration-static">{tr("用时", "Time")} {durationLabel}</div>
      ) : null}

      {/* Chronological intermediate commentary, subagents, & tool activity groups */}
      {hasIntermediateSteps && (
        <div
          id={stepsRegionId}
          className={`turn-steps-collapse ${stepsOpen || isRunning ? "is-open" : ""}`}
        >
          <div className="turn-steps-inner">
            {timelineBlocks.map((block) => {
              if (block.type === "commentary") {
                return (
                  <div className="turn-commentary" key={block.key}>
                    <MarkdownContent
                      text={block.text}
                      onOpenChatLink={handleOpenChatLink}
                      onOpenFile={handleOpenFile}
                      onOpenUrl={handleOpenUrl}
                      knownFiles={knownFiles}
                    />
                  </div>
                );
              }
              if (block.type === "agents") {
                return (
                  <SubagentBatchRow
                    key={block.key}
                    agents={block.agents}
                    onSelectAgent={handleSelectAgent}
                  />
                );
              }
              if (block.type === "tools") {
                return (
                  <ToolActivityCard
                    key={block.key}
                    events={block.events}
                    taskRunning={isRunning}
                    onOpenFile={handleOpenFile}
                    onOpenUrl={handleOpenUrl}
                  />
                );
              }
              return null;
            })}
          </div>
        </div>
      )}

      {/* Final assistant Markdown response */}
      {finalSegment?.text && (
        <div className="turn-final-answer">
          <MarkdownContent
            text={finalSegment.text}
            onOpenChatLink={handleOpenChatLink}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            knownFiles={knownFiles}
          />
        </div>
      )}

      {/* Generated / modified end-resource file cards */}
      {outputFiles.length > 0 && (
        <div className="end-resource-list" aria-label={tr("生成与更新的文件", "Generated and updated files")}>
          {outputFiles.map((item) => (
            <EndResourceCard
              key={item.path}
              filePath={item.path}
              action={item.action}
              onOpen={() => handleOpenFile({ path: item.path })}
            />
          ))}
          {totalChangedFiles > outputFiles.length && (
            <button
              type="button"
              className="text-btn erc-more-btn"
              onClick={() => openWorkspace?.({ type: "changes", botId })}
            >
              {tr("查看全部", "View all")} {totalChangedFiles} {tr("个变更文件", " changed files")}
            </button>
          )}
        </div>
      )}

      {/* Errors, re-auth, & interactive approval / NativeQuestions */}
      {task?.status === "failed" && task.error && <div className="task-error">{task.error}</div>}
      {shouldOfferAccountReauth(task, account) && (
        <button type="button" className="text-btn reauth" onClick={() => onLogin(account.id)}>
          <KeyRound size={12} />
          {tr("重新授权", "Reauthorize")}
        </button>
      )}
      {task?.status === "approval" && task.approval?.kind === "questions" && (
        <NativeQuestions
          key={task.approval.id}
          request={task.approval}
          busy={busy}
          submit={(answers) => act("answerQuestions", { taskId: task.id, requestId: task.approval.id, answers })}
        />
      )}
      {task?.status === "approval" && task.approval && task.approval.kind !== "questions" && (
        <div className="approval">
          <strong>
            <ShieldCheck size={15} />
            {task.approval.title || tr("原生工具请求权限", "The CLI requested permission")}
          </strong>
          {task.approval.detail && <pre>{task.approval.detail}</pre>}
          <div className="actions">
            <Button
              disabled={busy}
              onClick={() =>
                act("approve", {
                  taskId: task.id,
                  approvalId: task.approval.id,
                  allow: false,
                })
              }
            >
              {tr("拒绝", "Deny")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                act("approve", {
                  taskId: task.id,
                  approvalId: task.approval.id,
                  allow: true,
                })
              }
            >
              {tr("允许本次操作", "Allow once")}
            </Button>
          </div>
        </div>
      )}
      <Notice>{taskActionError}</Notice>

      {/* Codex-style subtle message action bar */}
      {(message?.text || canQuote || (!isRunning && hasRuntimeMeta)) && (
        <div className="codex-msg-actions">
          {message?.text && (
            <button
              type="button"
              className="codex-action-icon"
              aria-label={copied ? tr("已复制回复", "Reply copied") : tr("复制回复", "Copy reply")}
              title={copied ? tr("已复制", "Copied") : tr("复制", "Copy")}
              onClick={copyReply}
            >
              {copied ? <Check size={13.5} /> : <Copy size={13.5} />}
            </button>
          )}
          {hasRuntimeMeta && !isRunning && (
            <button
              type="button"
              className={`codex-action-icon ${showMeta ? "is-active" : ""}`}
              aria-label={tr("运行环境核验信息", "Runtime verification")}
              aria-expanded={showMeta}
              title={tr("查看运行环境核验", "View runtime verification")}
              onClick={() => setShowMeta((v) => !v)}
            >
              <ShieldCheck size={13.5} />
            </button>
          )}
          {canQuote && (
            <button
              type="button"
              className="quote-action"
              aria-description={tr(`${message.name}的消息`, `Message from ${message.name}`)}
              onClick={onQuote}
            >
              <Quote size={13} aria-hidden="true" />
              {tr("引用", "Quote")}
            </button>
          )}
        </div>
      )}

      {showMeta && hasRuntimeMeta && (
        <div className="codex-meta-strip">
          {(task?.tool || task?.identity) && (
            <div>
              <SquareTerminal size={12} />
              <span>{[task.tool, task.identity].filter(Boolean).join(" · ")}</span>
            </div>
          )}
          {task?.verifiedKey && (
            <div>
              <ShieldCheck size={12} />
              <span title={task.verifiedKey}>
                {tr("已核验账号 ·", "Verified account ·")}{" "}
                {task.verifiedKey.startsWith("codex:") ? task.verifiedKey.slice(6, 18) : task.verifiedKey}
              </span>
            </div>
          )}
          {metaEvents.map((ev, i) => (
            <div key={i}>
              <span className="event-dot" />
              <span>{ev.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Conversation({
  chat,
  state,
  invoke,
  open,
  onOpenChat,
  onNewDraft,
  openWorkspace,
  sourceControl,
  onDraftFiles,
  restoreChat,
  onError,
  firstProject,
}) {
  const tr = useLanguage();
  const { accounts, bots, messages, tasks } = state;
  function chatLink(url, children, key) {
    return (
      <a
        className="chat-deeplink"
        key={key}
        href={url}
        onClick={(event) => {
          event.preventDefault();
          invoke("openChatLink", { url }).catch((error) => onError(errorText(error)));
        }}
      >
        {children}
      </a>
    );
  }
  function linkChatText(text) {
    if (typeof text !== "string" || !text.toLowerCase().includes("boteam://chat/")) return text;
    return text
      .split(/(boteam:\/\/chat\/[a-f\d-]{36})/gi)
      .map((part, index) => (linkedChatId(part) ? chatLink(part, part, index) : part));
  }

  const log = useMemo(() => messages.filter((m) => m.chatId === chat.id), [messages, chat.id]);
  const jobs = useMemo(() => tasks.filter((t) => t.chatId === chat.id), [tasks, chat.id]);
  const members = chat.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b) => b && !b.archived);
  const group = chat.kind === "group";
  const quoteControl = useRef(null);
  const publicMessages = useMemo(
    () => new Map(group ? log.filter((m) => m.publishSeq > 0).map((m) => [m.id, m]) : []),
    [log, group],
  );
  const bottom = useRef(null);
  const scroll = useRef(null);
  const follow = useRef(true);
  const navigatorScrollTop = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, tasks]);

  const renderPendingTask = (task) => {
    const bot = bots.find((b) => b.id === task.botId);
    const account = accounts.find((a) => a.id === (task.accountId || bot?.accountId));
    return (
      <div key={task.id} className="pending-turn">
        <AssistantTurnBody
          message={null}
          task={task}
          bot={bot}
          account={account}
          group={group}
          canQuote={false}
          invoke={invoke}
          onLogin={(id) => open({ type: "login", id })}
          onError={onError}
          openWorkspace={openWorkspace}
        />
      </div>
    );
  };

  const replied = new Set(log.map((m) => m.taskId).filter(Boolean));
  const parentIds = new Set(log.map((m) => m.id));
  const sentExtensions = new Map();
  for (const job of jobs) {
    const labels = job.runSettings?.extensionLabels;
    if (!labels?.length) continue;
    const prefix = group ? (bots.find((b) => b.id === job.botId)?.name || tr("已归档 Bot", "Archived bot")) + " · " : "";
    const chips = sentExtensions.get(job.messageId) || [];
    sentExtensions.set(
      job.messageId,
      chips.concat(labels.map((label) => prefix + label)),
    );
  }
  const empty = !log.length && !jobs.length && !chat.sourceChatId;
  const directAccount = !group && accounts.find((a) => a.id === members[0]?.accountId);

  function jumpToConversationBottom() {
    follow.current = true;
    setShowScrollBottom(false);
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }

  return (
    <section className={`conversation${empty ? " is-empty" : ""}`} aria-label={chat.name || tr("对话", "Chat")}>
      <div className="message-scroll-stage">
        <div
          className="message-scroll"
          ref={scroll}
          onScroll={() => {
            const y = scroll.current;
            if (!y) return;
            if (y.scrollTop === navigatorScrollTop.current) return;
            navigatorScrollTop.current = null;
            const dist = y.scrollHeight - y.clientHeight - y.scrollTop;
            follow.current = dist < 100;
            setShowScrollBottom(dist > 180);
          }}
        >
          {!empty ? (
            <div className="message-log" role="log" aria-live="polite" aria-label={tr("消息记录", "Messages")}>
              {chat.sourceChatId && (
                <p className="fork-origin">
                  {tr("分支自「", "Branched from ")}{state.chats.find((c) => c.id === chat.sourceChatId)?.name || tr("原会话", "Original chat")}{tr("」", "")}
                  <button className="text-btn" onClick={() => onOpenChat(chat.sourceChatId)}>
                    {tr("查看原会话", "View original chat")}
                  </button>
                </p>
              )}
              {log.map((m) => {
                const bot = bots.find((b) => b.id === m.botId);
                const task = m.taskId && jobs.find((t) => t.id === m.taskId);
                const account = accounts.find((a) => a.id === (task?.accountId || bot?.accountId));
                const user = m.author === "user";
                const quoted = publicMessages.get(m.replyToMessageId);
                const canQuote = !chat.archived && publicMessages.has(m.id);

                return (
                  <article
                    key={m.id}
                    id={`message-${m.id}`}
                    tabIndex={-1}
                    className={`message ${user ? "user-message" : "bot-message"}`}
                  >
                    {user ? (
                      <>
                        <div className="user-bubble" aria-label="你的消息">
                          {group && m.recipients?.length > 0 && (
                            <div className="sent-recipients">
                              {m.recipients
                                .map((id) => "@" + (bots.find((b) => b.id === id)?.name || tr("已归档 Bot", "Archived bot")))
                                .join(" ")}
                            </div>
                          )}
                          {quoted && (
                            <button
                              type="button"
                              className="quote-card sent-quote"
                              aria-label={tr("查看引用原文", "View quoted message")}
                              aria-describedby={`quote-preview-${m.id}`}
                              onClick={() => {
                                const original = document.getElementById(`message-${quoted.id}`);
                                original?.focus({ preventScroll: true });
                                original?.scrollIntoView({ block: "center" });
                              }}
                            >
                              <MessageQuote message={quoted} descriptionId={`quote-preview-${m.id}`} />
                            </button>
                          )}
                          {m.attachments?.length > 0 && (
                            <div className="sent-attachments">
                              {m.attachments.map((file) => (
                                <span key={file.id} title={file.name}>
                                  <AttachmentPreview file={file} scope={m.chatId} />
                                  <Paperclip size={13} />
                                  <span>{file.name}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {sentExtensions.has(m.id) && (
                            <div className="sent-attachments" aria-label={tr("已发送扩展", "Sent extensions")}>
                              {sentExtensions.get(m.id).map((label, index) => (
                                <span key={index}>
                                  <Plug size={13} />
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                          {linkChatText(m.text)}
                        </div>
                        {canQuote && (
                          <button
                            type="button"
                            className="quote-action"
                            aria-description={tr(`${m.name}的消息`, `Message from ${m.name}`)}
                            onClick={() => quoteControl.current?.select(m.id)}
                          >
                            <Quote size={13} aria-hidden="true" />
                            {tr("引用", "Quote")}
                          </button>
                        )}
                        {jobs
                          .filter((t) => t.messageId === m.id && !replied.has(t.id))
                          .map((t) => renderPendingTask(t))}
                      </>
                    ) : (
                      <>
                        <AssistantTurnBody
                          message={m}
                          task={task}
                          bot={bot}
                          account={account}
                          group={group}
                          canQuote={canQuote}
                          onQuote={() => quoteControl.current?.select(m.id)}
                          invoke={invoke}
                          onLogin={(id) => open({ type: "login", id })}
                          onError={onError}
                          openWorkspace={openWorkspace}
                        />
                        {jobs
                          .filter((t) => t.messageId === m.id && !replied.has(t.id))
                          .map((t) => renderPendingTask(t))}
                      </>
                    )}
                  </article>
                );
              })}
              {jobs
                .filter((t) => !parentIds.has(t.messageId) && !replied.has(t.id))
                .map((t) => renderPendingTask(t))}
              <div ref={bottom} />
            </div>
          ) : (
            <div className="conversation-empty">
              <h1>{chat.name || members[0]?.name || tr("新对话", "New chat")}</h1>
              {group ? (
                <p>{tr("群聊 ·", "Group chat ·")} {members.length} {tr("位可用成员", " available members")}</p>
              ) : !members.length ? (
                <p>{tr("此 Bot 已归档", "This bot is archived")}</p>
              ) : directAccount?.note ? (
                <p>{directAccount.note}</p>
              ) : null}
              {group && (
                <div className="empty-member-strip">
                  {members.map((b) => (
                    <span key={b.id}>
                      <ProviderIcon
                        provider={accounts.find((a) => a.id === b.accountId)?.provider}
                        size="small"
                      />
                      {b.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {showScrollBottom && !empty && (
          <button
            type="button"
            className="conv-scroll-bottom"
            aria-label={tr("回到底部", "Back to bottom")}
            title={tr("回到底部", "Back to bottom")}
            onClick={jumpToConversationBottom}
          >
            <ArrowDown size={15} strokeWidth={2} />
          </button>
        )}
      </div>

      <MessageNavigator
        messages={log}
        tasks={jobs}
        scrollRef={scroll}
        onNavigate={(scroller) => {
          navigatorScrollTop.current = scroller.scrollTop;
          const dist = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
          follow.current = dist <= 2;
          setShowScrollBottom(dist > 180);
        }}
      />
      {chat.archived ? (
        <div className="archived-composer">
          <span>{tr("此聊天已归档", "This chat is archived")}</span>
          <Button onClick={restoreChat}>{tr("恢复聊天", "Restore chat")}</Button>
        </div>
      ) : (
        <Composer
          onOpenChat={onOpenChat}
          onNewDraft={onNewDraft}
          chat={chat}
          members={members}
          state={state}
          invoke={invoke}
          firstProject={firstProject}
          quoteControl={quoteControl}
          publicMessages={publicMessages}
          sourceControl={sourceControl}
          onDraftFiles={onDraftFiles}
        />
      )}
    </section>
  );
}
