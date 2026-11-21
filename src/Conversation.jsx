import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  KeyRound,
  Paperclip,
  Plug,
  Quote,
  ShieldCheck,
  Square,
  SquareTerminal,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Composer } from "./Composer";
import { MessageQuote } from "./MessageQuote";
import { AttachmentPreview } from "./AttachmentPreview";
import { Button, errorText, Notice, ProviderIcon, Spinner } from "./ui";
import "./conversation.css";

const taskLabels = {
  queued: "等待运行",
  running: "正在运行",
  approval: "等待审批",
  done: "已完成",
  failed: "运行失败",
  interrupted: "已中断",
};
const activeStatuses = ["queued", "running", "approval"];
const localTime = (s) =>
  s && !Number.isNaN(Date.parse(s))
    ? new Date(s).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
function NativeQuestions({ request, busy, submit }) {
  const [answers, setAnswers] = useState({});
  const [custom, setCustom] = useState({});
  const answer = (id, value) => setAnswers(previous => ({ ...previous, [id]: value }));
  return (
    <form className="approval native-questions" onSubmit={event => { event.preventDefault(); submit(answers); }}>
      {request.questions.map(question => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options.map(option => (
            <label key={option.label}>
              <input type="radio" name={request.id + question.id} disabled={busy}
                checked={!custom[question.id] && answers[question.id] === option.label}
                onChange={() => { setCustom(c => ({ ...c, [question.id]: false })); answer(question.id, option.label); }} />
              <span>{option.label}{option.description && <small>{option.description}</small>}</span>
            </label>
          ))}
          {question.isOther && question.options.length > 0 && (
            <label><input type="radio" name={request.id + question.id} disabled={busy}
              checked={Boolean(custom[question.id])}
              onChange={() => { setCustom(c => ({ ...c, [question.id]: true })); answer(question.id, ""); }} />其他</label>
          )}
          {(!question.options.length || custom[question.id]) && (
            <textarea aria-label={question.question} className="snippet-input" rows={2} maxLength={10000} required
              disabled={busy} value={answers[question.id] || ""} onChange={event => answer(question.id, event.target.value)} />
          )}
        </fieldset>
      ))}
      <div className="actions"><Button type="submit" variant="primary"
        disabled={busy || request.questions.some(q => !Object.hasOwn(answers, q.id) || !answers[q.id].trim())}>提交回答</Button></div>
    </form>
  );
}
function TaskView({ task, bot, account, invoke, onLogin, compact = false }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = activeStatuses.includes(task.status);
  const failed = ["failed", "interrupted"].includes(task.status);
  const Icon =
    task.status === "done"
      ? CircleCheck
      : failed
        ? CircleAlert
        : task.status === "approval"
          ? ShieldCheck
          : Clock3;
  async function act(method, payload) {
    setError("");
    setBusy(true);
    try {
      await invoke(method, payload);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`task ${compact ? "compact" : ""} ${failed ? "failed" : ""}`}
    >
      <div className="task-head">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          {task.status === "running" ? (
            <Spinner size={13} />
          ) : (
            <Icon size={13} />
          )}
          <span>
            {!compact && `${bot?.name || "Bot"} · `}
            {task.approval?.kind === "questions" ? "等待回答" : taskLabels[task.status] || task.status}
            {task.runSettings?.slashCommand && ` · /${task.runSettings.slashCommand}`}
          </span>
          {task.events?.length > 0 && (
            <small>{task.events.length} 条记录</small>
          )}
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {running && (
          <button
            className="text-btn task-stop"
            onClick={() => act("cancel", { taskId: task.id })}
            disabled={busy}
            title="停止任务"
          >
            <Square size={10} />
            停止
          </button>
        )}
      </div>
      {expanded && (
        <div className="task-details" id={detailsId}>
          {(task.tool || task.identity) && (
            <div>
              <SquareTerminal size={13} />
              <span>
                {[task.tool, task.identity].filter(Boolean).join(" · ")}
              </span>
            </div>
          )}
          {task.verifiedKey && (
            <div>
              <ShieldCheck size={13} />
              <span title={task.verifiedKey}>
                已核验账号 ·{" "}
                {task.verifiedKey.startsWith("codex:")
                  ? task.verifiedKey.slice(6, 18)
                  : task.verifiedKey}
              </span>
            </div>
          )}
          {task.events?.map((ev, i) => (
            <div key={i}>
              <span className="event-dot" />
              <span>{ev.text}</span>
            </div>
          ))}
          {!task.tool && !task.identity && !task.events?.length && (
            <div>暂无工具记录</div>
          )}
        </div>
      )}
      {failed && task.error && <div className="task-error">{task.error}</div>}
      {failed && account && (
        <button className="text-btn reauth" onClick={() => onLogin(account.id)}>
          <KeyRound size={12} />
          重新授权
        </button>
      )}
      {task.status === "approval" && task.approval?.kind === "questions" && (
        <NativeQuestions key={task.approval.id} request={task.approval} busy={busy}
          submit={answers => act("answerQuestions", { taskId: task.id, requestId: task.approval.id, answers })} />
      )}
      {task.status === "approval" && task.approval && task.approval.kind !== "questions" && (
        <div className="approval">
          <strong>
            <ShieldCheck size={15} />
            {task.approval.title || "原生工具请求权限"}
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
              拒绝
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
              允许本次操作
            </Button>
          </div>
        </div>
      )}
      <Notice>{error}</Notice>
    </div>
  );
}
export function Conversation({ chat, state, invoke, open, onOpenChat }) {
  const { accounts, bots, messages, tasks } = state;
  const log = useMemo(() => messages.filter(m => m.chatId === chat.id), [messages, chat.id]);
  const jobs = tasks.filter((t) => t.chatId === chat.id);
  const members = chat.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b) => b && !b.archived);
  const group = chat.kind === "group";
  const quoteControl = useRef(null);
  const publicMessages = useMemo(() => new Map(group
    ? log.filter(m => m.publishSeq > 0).map(m => [m.id, m])
    : []), [log, group]);
  const bottom = useRef(null);
  const scroll = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, tasks]);
  const taskRow = (task, compact = false) => (
    <TaskView
      key={task.id}
      task={task}
      compact={compact}
      bot={bots.find((b) => b.id === task.botId)}
      account={accounts.find((a) => a.id === task.accountId)}
      invoke={invoke}
      onLogin={(id) => open({ type: "login", id })}
    />
  );
  const replied = new Set(log.map((m) => m.taskId).filter(Boolean));
  const parentIds = new Set(log.map((m) => m.id));
  const sentExtensions = new Map();
  for (const job of jobs) {
    const labels = job.runSettings?.extensionLabels;
    if (!labels?.length) continue;
    const prefix = group ? (bots.find(b => b.id === job.botId)?.name || "已归档 Bot") + " · " : "";
    const chips = sentExtensions.get(job.messageId) || [];
    sentExtensions.set(job.messageId, chips.concat(labels.map(label => prefix + label)));
  }
  const empty = !log.length && !jobs.length && !chat.sourceChatId;
  const directAccount =
    !group && accounts.find((a) => a.id === members[0]?.accountId);
  return (
    <section
      className={`conversation${empty ? " is-empty" : ""}`}
      aria-label={chat.name || "对话"}
    >
      <div
        className="message-scroll"
        ref={scroll}
        onScroll={() => {
          const y = scroll.current;
          follow.current = y.scrollHeight - y.clientHeight - y.scrollTop < 100;
        }}
      >
        {!empty ? (
          <div
            className="message-log"
            role="log"
            aria-live="polite"
            aria-label="消息记录"
          >
            {chat.sourceChatId && (
              <p className="fork-origin">
                已继承 {members[0]?.name || "Bot"} 的原生上下文。
                <button className="text-btn" onClick={() => onOpenChat(chat.sourceChatId)}>查看原会话</button>
              </p>
            )}
            {log.map((m) => {
              const bot = bots.find((b) => b.id === m.botId);
              const task = m.taskId && jobs.find((t) => t.id === m.taskId);
              const account = accounts.find(
                (a) => a.id === (task?.accountId || bot?.accountId),
              );
              const user = m.author === "user";
              const quoted = publicMessages.get(m.replyToMessageId);
              return (
                <article
                  key={m.id}
                  id={`message-${m.id}`}
                  tabIndex={-1}
                  className={`message ${user ? "user-message" : "bot-message"}`}
                >
                  {!user && (
                    <div className="message-author">
                      <ProviderIcon provider={account?.provider} size="small" />
                      <strong>{m.name || bot?.name || "Bot"}</strong>
                      <time dateTime={m.createdAt}>
                        {localTime(m.createdAt)}
                      </time>
                    </div>
                  )}
                  {user ? (
                    <div className="user-bubble" aria-label="你的消息">
                      {group && m.recipients?.length > 0 && (
                        <div className="sent-recipients">
                          {m.recipients
                            .map(
                              (id) =>
                                "@" +
                                (bots.find((b) => b.id === id)?.name ||
                                  "已归档 Bot"),
                            )
                            .join(" ")}
                        </div>
                      )}
                      {quoted && (
                        <button
                          type="button"
                          className="quote-card sent-quote"
                          aria-label="查看引用原文"
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
                        <div className="sent-attachments" aria-label="已发送扩展">
                          {sentExtensions.get(m.id).map((label, index) => <span key={index}><Plug size={13} />{label}</span>)}
                        </div>
                      )}
                      {m.text}
                    </div>
                  ) : (
                    <div className="markdown">
                      <ReactMarkdown
                        components={{
                          a: ({ children, href }) => (
                            <span className="link-text" title={href}>
                              {children}
                              {href && <small>（{href}）</small>}
                            </span>
                          ),
                          img: ({ alt }) => <span>{alt || "图片"}</span>,
                        }}
                      >
                        {m.text || ""}
                      </ReactMarkdown>
                    </div>
                  )}
                  {publicMessages.has(m.id) && (
                    <button type="button" className="quote-action" aria-description={`${m.name}的消息`}
                      onClick={() => quoteControl.current?.select(m.id)}>
                      <Quote size={13} aria-hidden="true" />引用
                    </button>
                  )}
                  {task && taskRow(task, true)}
                  {jobs
                    .filter((t) => t.messageId === m.id && !replied.has(t.id))
                    .map((t) => taskRow(t))}
                </article>
              );
            })}
            {jobs
              .filter((t) => !parentIds.has(t.messageId) && !replied.has(t.id))
              .map((t) => taskRow(t))}
            <div ref={bottom} />
          </div>
        ) : (
          <div className="conversation-empty">
            <h1>{chat.name || members[0]?.name || "新对话"}</h1>
            {group ? (
              <p>群聊 · {members.length} 位可用成员</p>
            ) : !members.length ? (
              <p>此 Bot 已归档</p>
            ) : directAccount?.note ? (
              <p>{directAccount.note}</p>
            ) : null}
            {group && (
              <div className="empty-member-strip">
                {members.map((b) => (
                  <span key={b.id}>
                    <ProviderIcon
                      provider={
                        accounts.find((a) => a.id === b.accountId)?.provider
                      }
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
      <Composer onOpenChat={onOpenChat} chat={chat} members={members} state={state} invoke={invoke}
        quoteControl={quoteControl} publicMessages={publicMessages} />
    </section>
  );
}
