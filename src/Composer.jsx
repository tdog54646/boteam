import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  File,
  Folder,
  Plug,
  Square,
  Text,
  UsersRound,
  X,
} from "lucide-react";
import { resolveMentions } from "./mentions";
import {
  accountLabel,
  Button,
  errorText,
  IconButton,
  identityLabel,
  Modal,
  Notice,
  ProviderIcon,
  Spinner,
} from "./ui";
import {
  ComposerSlashMenu,
  slashToken,
  useComposerSlash,
} from "./ComposerSlash";
import { GoalDialog } from "./GoalDialog";
import { ComposerTools } from "./ComposerTools";
import { AttachmentPreview } from "./AttachmentPreview";
import { SketchDialog } from "./SketchDialog";

const drafts = new Map();
export function Composer({
  chat,
  members,
  state,
  invoke,
  homeBot,
  ensureHomeChat,
  onSent,
  onOpenChat = onSent,
  onBusyChange,
}) {
  const { accounts } = state;
  const scope = homeBot ? `home:${homeBot.id}` : chat.id;
  const ensured = () => (homeBot ? ensureHomeChat() : Promise.resolve(chat.id));
  const [text, setText] = useState(() => drafts.get(scope)?.text || "");
  const [selected, setSelected] = useState(
    () => drafts.get(scope)?.selected || [],
  );
  const [extensions, setExtensions] = useState(
    () => drafts.get(scope)?.extensions || {},
  );
  const [slashMember, setSlashMember] = useState(
    () => drafts.get(scope)?.slashMember,
  );
  const [slashDialog, setSlashDialog] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mention, setMention] = useState(null);
  const ref = useRef(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const menuId = useId();
  const isGroup = chat?.kind === "group";
  const [popup, setPopup] = useState(null);
  const [files, setFiles] = useState([]);
  const [filesReady, setFilesReady] = useState(false);
  const [workingFiles, setWorkingFiles] = useState(false);
  const [snippet, setSnippet] = useState(null);
  const [snippetType, setSnippetType] = useState("text");
  const [sketch, setSketch] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileLock = useRef(false);
  const sendLock = useRef(false);
  const pendingSlashSend = useRef(null);
  const activeTasks = state.tasks.filter(
    (task) =>
      task.chatId === chat?.id &&
      ["queued", "running", "approval"].includes(task.status),
  );
  useEffect(() => {
    onBusyChange?.(busy || workingFiles);
  }, [busy, workingFiles, onBusyChange]);
  useEffect(() => {
    if (text || selected.length || Object.keys(extensions).length)
      drafts.set(scope, { text, selected, extensions, slashMember });
    else drafts.delete(scope);
  }, [scope, text, selected, extensions, slashMember]);
  useEffect(() => {
    let current = true;
    invoke("listAttachments", { scope })
      .then((result) => {
        if (current) setFiles(result);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      })
      .finally(() => {
        if (current) setFilesReady(true);
      });
    return () => {
      current = false;
    };
  }, [scope, invoke]);
  useEffect(() => {
    if (!popup) return;
    function outside(event) {
      if (!event.target.closest?.(".composer-slot")) setPopup(null);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [popup]);
  useEffect(() => {
    if (!open) return;
    function outside(e) {
      if (!root.current?.contains(e.target)) {
        setOpen(false);
        setMention(null);
      }
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const slashTarget = isGroup
    ? members.find(
        (b) => b.id === (slashMember || (selected.length === 1 && selected[0])),
      )
    : members[0];
  const slash = useComposerSlash({
    text,
    target: slashTarget,
    chatId: chat?.id,
    invoke,
  });
  const slashOpen = slash.open && !popup && !open && !slashDialog && !busy;
  useEffect(() => {
    if (!slashOpen) return;
    function outside(event) {
      if (
        !event.target.closest?.(".slash-menu") &&
        event.target !== ref.current
      ) {
        pendingSlashSend.current = null;
        slash.dismiss();
      }
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [slashOpen]);
  const tokens =
    isGroup && !slash.match ? resolveMentions(text, members, selected) : [];
  const ambiguous = tokens.some((token) => token.ambiguous);
  const recipients = isGroup
    ? [
        ...new Set([...selected, ...tokens.flatMap((token) => token.ids)]),
      ].filter((id) => members.some((bot) => bot.id === id))
    : members.slice(0, 1).map((b) => b.id);
  const editingMention =
    mention &&
    !tokens.some(
      (token) => token.start === mention.start && token.end === mention.end,
    );
  const hasCommand =
    recipients.length > 0 && recipients.every((id) => extensions[id]?.length);
  const stopping =
    activeTasks.length > 0 && !text.trim() && !files.length && !hasCommand;
  const canSend = Boolean(
    (text.trim() || files.length || hasCommand) &&
      (recipients.length || slash.match) &&
      !ambiguous &&
      !editingMention &&
      !busy &&
      filesReady &&
      !workingFiles,
  );
  function removeExtension(botId, id) {
    setExtensions((previous) => {
      const next = { ...previous };
      const retained = previous[botId]?.filter((item) => item.id !== id) || [];
      if (retained.length) next[botId] = retained;
      else delete next[botId];
      return next;
    });
  }
  function toggleExtension(bot, item, maxExtensions, singleRecipient = false) {
    const list = extensions[bot.id] || [];
    if (list.some((entry) => entry.id === item.id))
      removeExtension(bot.id, item.id);
    else {
      if (maxExtensions > 1 && list.length >= maxExtensions) {
        setError(`每条消息最多为此成员选择 ${maxExtensions} 项扩展。`);
        return;
      }
      if (isGroup && singleRecipient) setSelected([bot.id]);
      else if (isGroup && !recipients.includes(bot.id))
        setSelected((ids) => [...ids, bot.id]);
      setExtensions((previous) => ({
        ...(singleRecipient ? {} : previous),
        [bot.id]:
          maxExtensions === 1 ? [item] : [...(previous[bot.id] || []), item],
      }));
    }
    ref.current?.focus();
  }
  function removeRecipient(id) {
    setExtensions((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    const matches = tokens.filter((token) => token.ids.includes(id));
    let nextText = text;
    for (const token of matches.toReversed())
      nextText = nextText.slice(0, token.start) + nextText.slice(token.end);
    setText(nextText);
    setSelected(
      [
        ...new Set([...selected, ...matches.flatMap((token) => token.ids)]),
      ].filter((value) => value !== id),
    );
  }
  const query = mention?.term?.toLowerCase() || "";
  const shown = members.filter((b) => {
    const a = accounts.find((x) => x.id === b.accountId);
    return [b.name, a?.note, a?.email, a?.identity].some((s) =>
      s?.toLowerCase().includes(query),
    );
  });
  function closeMenu() {
    setOpen(false);
    setMention(null);
  }
  function moveInMenu(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      (mention ? ref : trigger).current?.focus();
    }
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const options = [...menu.current.querySelectorAll(".recipient-option")];
    if (!options.length) return;
    e.preventDefault();
    const i = options.indexOf(document.activeElement);
    const next =
      e.key === "ArrowDown" ? i + 1 : i <= 0 ? options.length - 1 : i - 1;
    options[next % options.length].focus();
  }
  function select(ids) {
    setSelected([...new Set(ids)]);
    setOpen(false);
    if (mention) {
      setText((t) => t.slice(0, mention.start) + t.slice(mention.end));
      setMention(null);
    }
    ref.current?.focus();
  }
  function toggleRecipient(id) {
    if (!mention && recipients.includes(id)) {
      removeRecipient(id);
      closeMenu();
      ref.current?.focus();
      return;
    }
    select([...selected, id]);
  }
  function change(e) {
    const value = e.target.value;
    setText(value);
    pendingSlashSend.current = null;
    slash.reveal();
    if (error) setError("");
    if (!value.trimStart().startsWith("/") || !text.trimStart().startsWith("/"))
      setSlashMember(null);
    if (slashToken(value)) {
      closeMenu();
      setPopup(null);
      return;
    }
    if (!isGroup) return;
    const end = e.target.selectionStart;
    const match = value
      .slice(0, end)
      .match(/(?:^|[\s，。！？])[@＠]([^\s@＠]*)$/u);
    if (match) {
      setMention({ start: end - match[1].length - 1, end, term: match[1] });
      setOpen(true);
    } else if (mention) {
      setOpen(false);
      setMention(null);
    }
  }
  async function modifyFiles(operation) {
    if (fileLock.current || !filesReady || busy || !members.length)
      return false;
    fileLock.current = true;
    setWorkingFiles(true);
    setPopup(null);
    setError("");
    try {
      await operation();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      fileLock.current = false;
      setWorkingFiles(false);
    }
  }
  async function addFiles(files) {
    const added = await invoke("addAttachments", { scope, files });
    setFiles((previous) => [...previous, ...added]);
  }
  function importFiles(list, dropped = false, hasFolder = false) {
    const incoming = Array.from(list);
    return modifyFiles(async () => {
      if (dropped && window.boteam.dropAttachments) {
        const added = await window.boteam.dropAttachments(scope, incoming);
        if (added) {
          setFiles((previous) => [...previous, ...added]);
          return;
        }
      }
      if (hasFolder)
        throw new Error("请通过加号菜单的「文件和文件夹」选择要附加的文件夹。");
      const mib = 1024 * 1024;
      if (
        incoming.some((f) => f.size > 32 * mib) ||
        incoming.reduce((sum, f) => sum + f.size, 0) > 64 * mib
      )
        throw new Error("文件较大，请使用加号菜单中的「添加文件」选择。");
      const files = await Promise.all(
        incoming.map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      await addFiles(files);
    });
  }
  async function stop() {
    if (busy || sendLock.current) return;
    sendLock.current = true;
    setBusy(true);
    setError("");
    try {
      const outcomes = await Promise.allSettled(
        activeTasks.map((task) => invoke("cancel", { taskId: task.id })),
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed) throw failed.reason;
    } catch (e) {
      setError(errorText(e));
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  function selectSlashMember(id) {
    setSlashMember(id);
    slash.reveal();
    ref.current?.focus();
  }
  function chooseSlash(command, fromSend = false) {
    if (busy || !slashTarget || !command) return;
    const { action, name } = command;
    const botId = slashTarget.id;
    const args = slash.exact?.name === name ? slash.args : "";
    setError("");
    if (["prompt", "compact", "review", "extension"].includes(action)) {
      if (fromSend || (slash.exact && slash.hasArguments)) {
        if (Object.values(extensions).some((items) => items.length)) {
          setError("请移除已选插件与技能，再单独发送这条快捷命令。");
          return;
        }
        sendMessage({ botId, name, arguments: args });
      } else {
        setSlashMember(botId);
        setText("/" + name + " ");
        slash.dismiss();
        ref.current?.focus();
      }
      return;
    }
    if (action === "unavailable") {
      setError(command.reason || "此命令需要在原生工具中使用。");
      return;
    }
    if (args && action !== "goal") {
      setError("此快捷方式在面板中操作，请移除命令后的参数。");
      return;
    }
    async function runControl() {
      if (sendLock.current) return;
      sendLock.current = true;
      setBusy(true);
      try {
        if (
          ["model", "permission", "quota", "context", "skills"].includes(action)
        ) {
          setPopup({
            id: action === "skills" ? "add" : action,
            pinned: true,
            botId,
            skillsOnly: action === "skills",
          });
        } else if (action === "goal") {
          setSlashDialog({ action, bot: slashTarget, args });
        } else if (action === "plan") {
          const settings = state.composerSettings?.find(
            (s) => s.chatId === chat?.id && s.botId === botId,
          );
          const planMode = !(
            settings?.planMode || settings?.permission === "plan"
          );
          await invoke("setComposerSettings", {
            chatId: await ensured(),
            botId,
            planMode,
          });
          setSlashDialog({
            action,
            bot: slashTarget,
            title: "计划模式",
            lines: [planMode ? "已开启计划模式" : "已关闭计划模式"],
          });
        } else if (action === "mcp") {
          const info = await invoke("slashInfo", {
            ...(chat?.id && { chatId: chat.id }),
            botId,
            name,
          });
          setSlashDialog({ ...info, action, bot: slashTarget });
        } else if (action === "new" || action === "fork") {
          if (action === "fork" && !chat?.id)
            throw new Error("请先在此聊天中完成一次原生对话，再创建分支。");
          const id =
            action === "fork"
              ? await invoke("forkChat", { chatId: chat.id, botId })
              : await invoke("createChat", {
                  kind: "direct",
                  members: [botId],
                });
          await onOpenChat(id);
          drafts.set(scope, { text: "", extensions, selected });
        } else {
          throw new Error("此快捷命令尚未接入。");
        }
        setText("");
        slash.dismiss();
      } catch (e) {
        setError(errorText(e));
      } finally {
        sendLock.current = false;
        setBusy(false);
      }
    }
    runControl();
  }
  function send() {
    if (!canSend) return;
    if (slash.match) {
      if (!slashTarget || !slash.ready || slash.error) {
        slash.reveal();
        if (slashTarget && !slash.ready && slash.name)
          pendingSlashSend.current = { text, target: slashTarget.id };
        if (slash.error) slash.retry();
        return;
      }
      if (slash.exact) return chooseSlash(slash.exact, true);
      if (slashOpen && slash.rows.length)
        return chooseSlash(slash.rows[slash.index]);
      if (text === "/") return slash.reveal();
      setError("当前成员的原生工具未提供 /" + slash.name + "。");
      return;
    }
    sendMessage();
  }
  useEffect(() => {
    const pending = pendingSlashSend.current;
    if (!pending) return;
    if (
      text !== pending.text ||
      slashTarget?.id !== pending.target ||
      slash.error
    ) {
      pendingSlashSend.current = null;
    } else if (slash.ready) {
      pendingSlashSend.current = null;
      send();
    }
  }, [text, slashTarget?.id, slash.ready, slash.error]);
  async function sendMessage(command) {
    if (!canSend || sendLock.current || fileLock.current) return;
    sendLock.current = true;
    setBusy(true);
    setError("");
    try {
      const chatId = await ensured();
      const nativeActions = Object.fromEntries(
        recipients
          .filter((id) => extensions[id]?.length)
          .map((id) => [
            id,
            {
              extensionIds: extensions[id].map((item) => item.id),
              labels: extensions[id].map((item) => item.label),
            },
          ]),
      );
      await invoke("send", {
        ...(command ? { slash: command } : { nativeActions }),
        chatId,
        text: command
          ? ("/" + command.name + " " + command.arguments).trimEnd()
          : text.trim(),
        recipients: command ? [command.botId] : recipients,
        attachmentIds: files.map((file) => file.id),
      });
      drafts.delete(scope);
      setFiles([]);
      setPopup(null);
      setText("");
      setSlashMember(null);
      setSelected([]);
      setExtensions({});
      setOpen(false);
      setMention(null);
      ref.current?.focus();
      await onSent?.(chatId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className={`composer-area${homeBot ? " home-composer" : ""}`}>
      <div className="composer-wrap" ref={root}>
        {slashOpen && (
          <ComposerSlashMenu
            slash={slash}
            members={members}
            accounts={accounts}
            target={slashTarget}
            isGroup={isGroup}
            root={root}
            onTarget={selectSlashMember}
            onChoose={chooseSlash}
          />
        )}
        {isGroup && open && (
          <div
            className="recipient-menu"
            ref={menu}
            id={menuId}
            role="group"
            aria-label="选择接收人"
            onKeyDown={moveInMenu}
          >
            <div className="recipient-menu-header">
              <strong>选择接收人</strong>
              <IconButton
                icon={X}
                label="关闭接收人列表"
                onClick={() => {
                  closeMenu();
                  ref.current?.focus();
                }}
              />
            </div>
            {"全体成员".includes(query) && members.length > 0 && (
              <button
                type="button"
                className="recipient-option"
                onClick={() => select(members.map((b) => b.id))}
              >
                <UsersRound size={16} />
                <span>全体成员</span>
                <small>{members.length} 位</small>
              </button>
            )}
            {shown.map((b) => {
              const a = accounts.find((x) => x.id === b.accountId);
              return (
                <button
                  type="button"
                  key={b.id}
                  className="recipient-option"
                  aria-pressed={recipients.includes(b.id)}
                  onClick={() => toggleRecipient(b.id)}
                >
                  <ProviderIcon provider={a?.provider} size="small" />
                  <span>
                    {b.name}
                    <small>
                      {accountLabel(a)}
                      {a?.note ? ` · ${identityLabel(a)}` : ""}
                    </small>
                  </span>
                  {recipients.includes(b.id) && <Check size={15} />}
                </button>
              );
            })}
            {!shown.length &&
              (!members.length || !"全体成员".includes(query)) && (
                <p className="menu-empty">没有匹配的群成员</p>
              )}
          </div>
        )}
        <div
          className={`composer${dragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={() => {
            if (--dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            dragDepth.current = 0;
            setDragging(false);
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              const hasFolder = [...event.dataTransfer.items].some(
                (item) => item.webkitGetAsEntry?.()?.isDirectory,
              );
              importFiles(event.dataTransfer.files, true, hasFolder);
            }
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              importFiles(event.clipboardData.files);
            }
          }}
        >
          {files.length > 0 && (
            <div className="attachment-chips" aria-label="待发送附件">
              {files.map((file) => {
                const Icon =
                  file.kind === "folder"
                    ? Folder
                    : file.kind === "text"
                      ? Text
                      : File;
                return (
                  <span key={file.id} title={file.name}>
                    {file.kind === "file" && (
                      <AttachmentPreview scope={scope} file={file} />
                    )}
                    <Icon size={14} />
                    <span title={file.name}>{file.name}</span>
                    {file.kind === "folder" &&
                      Number.isInteger(file.fileCount) && (
                        <small>
                          {file.fileCount} 个文件
                          {file.skippedCount > 0
                            ? ` · 已跳过 ${file.skippedCount} 项`
                            : ""}
                        </small>
                      )}
                    <button
                      type="button"
                      disabled={workingFiles || busy}
                      aria-label={`移除附件 ${file.name}`}
                      onClick={() =>
                        modifyFiles(async () => {
                          await invoke("removeAttachment", {
                            scope,
                            id: file.id,
                          });
                          setFiles((previous) =>
                            previous.filter((f) => f.id !== file.id),
                          );
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {recipients.some((id) => extensions[id]?.length) && (
            <div className="attachment-chips" aria-label="已选插件与技能">
              {recipients.flatMap((id) =>
                (extensions[id] || []).map((item) => (
                  <span key={id + item.id}>
                    <Plug size={13} />
                    <span>
                      {isGroup &&
                        members.find((m) => m.id === id)?.name + " · "}
                      {item.label}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`移除 ${item.label}`}
                      onClick={() => removeExtension(id, item.id)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                )),
              )}
            </div>
          )}
          {slash.exact &&
            slash.hasArguments &&
            (slash.exact.argumentHint || isGroup) && (
              <small className="slash-caption">
                {isGroup &&
                  slashTarget.name +
                    " · " +
                    accountLabel(
                      accounts.find((a) => a.id === slashTarget.accountId),
                    )}
                {isGroup && slash.exact.argumentHint && " · "}
                {slash.exact.argumentHint}
              </small>
            )}
          {isGroup && !slash.match && recipients.length > 0 && (
            <div className="recipient-chips">
              {recipients.map((id) => (
                <button
                  type="button"
                  key={id}
                  aria-label={`移除接收人 ${members.find((b) => b.id === id)?.name}`}
                  title="移除接收人"
                  onClick={() => removeRecipient(id)}
                >
                  @{members.find((b) => b.id === id)?.name}
                  <X size={11} />
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={
              !members.length
                ? "此对话的 Bot 已归档"
                : isGroup
                  ? "输入消息，使用 @ 选择接收人…"
                  : `和 ${members[0].name} 一起工作`
            }
            disabled={!members.length}
            readOnly={busy}
            autoFocus
            maxLength={200000}
            aria-label={homeBot ? "新对话消息" : "消息内容"}
            aria-autocomplete="list"
            aria-controls={slashOpen ? slash.listId : undefined}
            aria-activedescendant={
              slashOpen && (slashTarget ? slash.rows.length : members.length)
                ? slash.listId + "-" + slash.index
                : undefined
            }
            onFocus={() => {
              if (!slash.hasArguments) slash.reveal();
            }}
            onChange={change}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (slashOpen && !e.shiftKey) {
                const choices = slashTarget ? slash.rows : members;
                if (e.key === "Escape") {
                  pendingSlashSend.current = null;
                  e.preventDefault();
                  slash.dismiss();
                  return;
                }
                if (
                  choices.length &&
                  ["ArrowDown", "ArrowUp"].includes(e.key)
                ) {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  slash.setActive(
                    (slash.index + choices.length + step) % choices.length,
                  );
                  return;
                }
                if (choices.length && (e.key === "Enter" || e.key === "Tab")) {
                  e.preventDefault();
                  if (slashTarget) chooseSlash(choices[slash.index]);
                  else selectSlashMember(choices[slash.index].id);
                  return;
                }
              }
              if (e.key === "Escape") {
                setPopup(null);
                closeMenu();
                return;
              }
              if (e.key === "ArrowDown" && open) {
                moveInMenu(e);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) {
                  send();
                } else if (open && mention && shown.length === 1) {
                  select([...selected, shown[0].id]);
                } else if (isGroup) {
                  setOpen(true);
                }
              }
            }}
          />
          <div className="composer-tools">
            <ComposerTools
              filesDisabled={
                !members.length || workingFiles || !filesReady || busy
              }
              onFiles={() =>
                modifyFiles(async () => {
                  const added = await invoke("pickAttachments", { scope });
                  setFiles((previous) => [...previous, ...added]);
                })
              }
              onSnippet={() => {
                setError("");
                setPopup(null);
                setSnippetType("text");
                setSnippet("");
              }}
              onEditor={() => {
                setError("");
                setPopup(null);
                setSnippetType("editor");
                setSnippet("");
              }}
              onSketch={() => {
                setError("");
                setPopup(null);
                setSketch(true);
              }}
              onNative={toggleExtension}
              onGoalStarted={homeBot ? onSent : undefined}
              selectedExtensions={extensions}
              commandMemberId={slash.match ? slashTarget?.id : undefined}
              onCommandMemberChange={setSlashMember}
              chatId={chat?.id}
              state={state}
              members={members}
              isGroup={isGroup}
              recipients={recipients}
              invoke={invoke}
              ensureChat={ensured}
              popup={popup}
              setPopup={(next) => {
                if (open) closeMenu();
                setPopup(next);
              }}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
            >
              {isGroup && (
                <button
                  type="button"
                  className="recipient-trigger"
                  disabled={!members.length}
                  aria-expanded={open}
                  aria-controls={open ? menuId : undefined}
                  title="选择接收人"
                  aria-label="选择接收人"
                  ref={trigger}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" && open) moveInMenu(e);
                  }}
                  onClick={() => {
                    setPopup(null);
                    setMention(null);
                    setOpen((x) => !x);
                  }}
                >
                  <AtSign size={15} />
                </button>
              )}
            </ComposerTools>
            <button
              type="button"
              className="send-btn"
              aria-label={stopping ? "停止当前对话任务" : "发送消息"}
              title={stopping ? "停止当前对话任务" : "发送消息"}
              disabled={stopping ? busy : !canSend}
              onClick={stopping ? stop : send}
            >
              {busy ? (
                <Spinner size={15} />
              ) : stopping ? (
                <Square size={10} fill="currentColor" />
              ) : (
                <ArrowUp size={17} />
              )}
            </button>
          </div>
        </div>
        {slashDialog?.action === "goal" && (
          <GoalDialog
            bot={slashDialog.bot}
            initialObjective={slashDialog.args}
            chatId={chat?.id}
            ensureChat={ensured}
            invoke={invoke}
            onStarted={homeBot ? onSent : undefined}
            onClose={() => setSlashDialog(null)}
          />
        )}
        {slashDialog && slashDialog.action !== "goal" && (
          <Modal
            title={slashDialog.title}
            subtitle={
              slashDialog.bot.name +
              " · " +
              accountLabel(
                accounts.find((a) => a.id === slashDialog.bot.accountId),
              )
            }
            onClose={() => setSlashDialog(null)}
          >
            <ul className="slash-info">
              {slashDialog.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </Modal>
        )}
        {snippet !== null && (
          <Modal
            title={snippetType === "editor" ? "附加编辑器选区" : "添加文本"}
            onClose={() => {
              if (!workingFiles) setSnippet(null);
            }}
          >
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!snippet.trim()) return;
                const added = await modifyFiles(() =>
                  addFiles([
                    {
                      name:
                        snippetType === "editor"
                          ? "编辑器选区.txt"
                          : "添加的文本.txt",
                      text: snippet,
                    },
                  ]),
                );
                if (added) setSnippet(null);
              }}
            >
              <textarea
                className="snippet-input"
                data-autofocus
                aria-label="文本内容"
                placeholder={
                  snippetType === "editor"
                    ? "从编辑器复制选区，然后粘贴到这里"
                    : "输入或粘贴文本"
                }
                value={snippet}
                onChange={(e) => setSnippet(e.target.value)}
                disabled={workingFiles}
                rows={8}
              />
              <Notice>{error}</Notice>
              <div className="form-actions">
                <Button
                  onClick={() => setSnippet(null)}
                  disabled={workingFiles}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  busy={workingFiles}
                  disabled={!snippet.trim()}
                >
                  添加到消息
                </Button>
              </div>
            </form>
          </Modal>
        )}
        {sketch && (
          <SketchDialog
            busy={workingFiles}
            error={error}
            onClose={() => {
              if (!workingFiles) setSketch(false);
            }}
            onAdd={async (canvas) => {
              const added = await modifyFiles(async () => {
                const blob = await new Promise((resolve) =>
                  canvas.toBlob(resolve, "image/png"),
                );
                if (!blob) throw new Error("无法导出草图，请重试。");
                await addFiles([
                  {
                    name: "草图.png",
                    bytes: new Uint8Array(await blob.arrayBuffer()),
                  },
                ]);
              });
              if (added) setSketch(false);
            }}
          />
        )}
        <Notice>
          {(snippet === null && !sketch && error) ||
            (ambiguous ? "群中有同名 Bot，请从接收人列表中按账号选择。" : "")}
        </Notice>
      </div>
    </div>
  );
}
