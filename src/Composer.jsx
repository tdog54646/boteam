import { useLanguage } from "./preferences";
import React, { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { useComposerActions } from "./useComposerActions";
import { AttachmentPreview } from "./AttachmentPreview";
import { SketchDialog } from "./SketchDialog";
import { MessageQuote } from "./MessageQuote";
import { FirstChatProject } from "./FirstChatProject";
import {
  deleteComposerDraft,
  getComposerDraft,
  setComposerDraft,
  subscribeComposerDraft,
} from "./composerDrafts";

export function Composer({
  chat,
  members,
  state,
  invoke,
  draft,
  onNewDraft,
  onSent,
  onOpenChat = onSent,
  onBusyChange,
  quoteControl,
  sourceControl,
  onDraftFiles,
  publicMessages,
  firstProject,
}) {
  const tr = useLanguage();
  const { accounts } = state;
  const scope = draft ? (draft.legacyHome ? `home:${draft.members[0]}` : `draft:${draft.id}`) : chat.id;
  const projectCwd = chat ? chat.initialProjectCwd ?? null : draft?.folder ??
    state.projects?.find(project => project.id === draft?.projectId)?.folders[0] ?? null;
  const [settingsByBot, setSettingsByBot] = useState(() => getComposerDraft(scope)?.settingsByBot || {});
  const [pausedGoals, setPausedGoals] = useState(() => getComposerDraft(scope)?.pausedGoals || {});
  const [text, setText] = useState(() => getComposerDraft(scope)?.text || "");
  const [replyToMessageId, setReplyToMessageId] = useState(() => getComposerDraft(scope)?.replyToMessageId || null);
  const quotedMessage = publicMessages?.get(replyToMessageId);
  const quoteDescriptionId = useId();
  const [selected, setSelected] = useState(
    () => getComposerDraft(scope)?.selected || [],
  );
  const [extensions, setExtensions] = useState(
    () => getComposerDraft(scope)?.extensions || {},
  );
  const [slashMember, setSlashMember] = useState(
    () => getComposerDraft(scope)?.slashMember,
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
  const isGroup = (chat || draft)?.kind === "group";
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
  const suppressDraftSave = useRef(false);
  const pendingSlashSend = useRef(null);
  useImperativeHandle(sourceControl, () => ({ pickFiles }));
  const canPick = filesReady && !busy && !workingFiles && members.length > 0;
  useEffect(() => {
    onDraftFiles?.({ chatId: chat?.id || draft?.id, files, canPick });
  }, [chat?.id, draft?.id, files, canPick, onDraftFiles]);
  useImperativeHandle(quoteControl, () => ({
    select(messageId) {
      if (sendLock.current) return;
      setReplyToMessageId(messageId);
      setError("");
      ref.current?.focus();
    },
  }), []);
  const activeTasks = state.tasks.filter(
    (task) =>
      task.chatId === chat?.id &&
      ["queued", "running", "approval"].includes(task.status),
  );
  useEffect(() => {
    onBusyChange?.(busy || workingFiles);
  }, [busy, workingFiles, onBusyChange]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.value.length > 0) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [scope]);
  useLayoutEffect(() => {
    if (suppressDraftSave.current) return;
    setComposerDraft(scope, {
      text,
      selected,
      extensions,
      slashMember,
      replyToMessageId,
      settingsByBot,
      pausedGoals,
      hasAttachments: filesReady && files.length > 0,
    });
  }, [scope, text, selected, extensions, slashMember, replyToMessageId, settingsByBot, pausedGoals, filesReady, files.length]);
  useEffect(() => {
    return subscribeComposerDraft(scope, (remote) => {
      if (sendLock.current) return;
      setText(remote?.text || "");
      setSelected(remote?.selected || []);
      setExtensions(remote?.extensions || {});
      setSlashMember(remote?.slashMember);
      setReplyToMessageId(remote?.replyToMessageId || null);
      setSettingsByBot(remote?.settingsByBot || {});
      setPausedGoals(remote?.pausedGoals || {});
    });
  }, [scope]);
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
  const match = slashToken(text);
  const tokens = isGroup && !match ? resolveMentions(text, members, selected) : [];
  const recipients = isGroup
    ? [...new Set([...selected, ...tokens.flatMap(token => token.ids)])].filter(id => members.some(bot => bot.id === id))
    : members.slice(0, 1).map(b => b.id);
  const recipientKey = recipients.join(",");
  const [inspected, setInspected] = useState(null);
  const inspectedId = (match && slashTarget?.id) || popup?.botId ||
    (inspected?.recipients === recipientKey ? inspected.id : recipients[0]);
  const inspectedBot = members.find(member => member.id === inspectedId) || members[0];
  const actions = useComposerActions({ state, chat, draft, bot: inspectedBot, projectCwd,
    draftSettings: draft && settingsByBot[inspectedBot?.id], invoke });
  const slash = useComposerSlash({ match, target: slashTarget, actions });
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
  const ambiguous = tokens.some((token) => token.ambiguous);
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
      !firstProject?.disabled &&
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
        setError(tr(`每条消息最多为此成员选择 ${maxExtensions} 项扩展。`, `Choose up to ${maxExtensions} extensions per message for this member.`));
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
  const matchesEveryone = tr("全体成员", "Everyone").toLowerCase().includes(query);
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
  function pickFiles() {
    return modifyFiles(async () => {
      const added = await invoke("pickAttachments", { scope });
      setFiles(previous => [...previous, ...added]);
    });
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
        throw new Error(tr("请通过加号菜单的「文件和文件夹」选择要附加的文件夹。", "Choose Files and folders in the plus menu to attach a folder."));
      const mib = 1024 * 1024;
      if (
        incoming.some((f) => f.size > 32 * mib) ||
        incoming.reduce((sum, f) => sum + f.size, 0) > 64 * mib
      )
        throw new Error(tr("文件较大，请使用加号菜单中的「添加文件」选择。", "Choose this large file using Add files in the plus menu."));
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
    if (busy || firstProject?.disabled || !slashTarget || !command) return;
    if (replyToMessageId) {
      setError(tr("请先移除引用，再执行快捷命令。", "Remove the quote before running a shortcut."));
      return;
    }
    const { action, name } = command;
    const botId = slashTarget.id;
    const args = slash.exact?.name === name ? slash.args : "";
    setError("");
    if (["prompt", "compact", "review", "extension"].includes(action)) {
      if (fromSend || (slash.exact && slash.hasArguments)) {
        if (Object.values(extensions).some((items) => items.length)) {
          setError(tr("请移除已选插件与技能，再单独发送这条快捷命令。", "Remove the selected plugins and skills before sending this shortcut."));
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
      setError(command.reason || tr("此命令需要在原生工具中使用。", "Run this command in the native CLI."));
      return;
    }
    if (args && action !== "goal") {
      setError(tr("此快捷方式在面板中操作，请移除命令后的参数。", "This shortcut opens a panel. Remove the arguments after the command."));
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
          const settings = settingsByBot[botId] || state.composerSettings?.find(
            (s) => s.chatId === chat?.id && s.botId === botId,
          );
          const planMode = !(
            settings?.planMode || settings?.permission === "plan"
          );
          await saveSettings(botId, { planMode });
          setSlashDialog({
            action,
            bot: slashTarget,
            title: tr("计划模式", "Plan mode"),
            lines: [planMode ? tr("已开启计划模式", "Plan mode enabled") : tr("已关闭计划模式", "Plan mode disabled")],
          });
        } else if (action === "mcp") {
          const info = await invoke("slashInfo", {
            ...(chat?.id && { chatId: chat.id }),
            ...(draft && settingsByBot[botId] && { settings: settingsByBot[botId] }),
            botId,
            name,
          });
          setSlashDialog({ ...info, action, bot: slashTarget });
        } else if (action === "new" || action === "fork") {
          if (action === "fork" && !chat?.id)
            throw new Error(tr("请先在此聊天中完成一次原生对话，再创建分支。", "Finish a native turn in this chat before creating a branch."));
          if (action === "fork") {
            await onOpenChat(await invoke("forkChat", { chatId: chat.id, botId }));
          } else {
            onNewDraft({ kind: "direct", members: [botId], projectId: chat?.projectId || firstProject?.projectId });
          }
          suppressDraftSave.current = true;
          setComposerDraft(scope, { ...getComposerDraft(scope), text: "" });
        } else {
          throw new Error(tr("此快捷命令尚未接入。", "This shortcut is unavailable."));
        }
        setText("");
        suppressDraftSave.current = false;
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
          pendingSlashSend.current = { text, botId: slashTarget.id, scope: actions.scope };
        if (slash.error) slash.retry?.();
        return;
      }
      if (slash.exact) return chooseSlash(slash.exact, true);
      if (slashOpen && slash.rows.length)
        return chooseSlash(slash.rows[slash.index]);
      if (text === "/") return slash.reveal();
      setError(tr("当前成员的原生工具未提供 /", "This member’s CLI does not provide /") + slash.name + "。");
      return;
    }
    sendMessage();
  }
  useEffect(() => {
    const pending = pendingSlashSend.current;
    if (!pending) return;
    if (
      text !== pending.text ||
      slashTarget?.id !== pending.botId ||
      actions.scope !== pending.scope ||
      slash.error
    ) {
      pendingSlashSend.current = null;
    } else if (slash.ready) {
      pendingSlashSend.current = null;
      send();
    }
  }, [text, slashTarget?.id, actions.scope, slash.ready, slash.error]);
  const settingsSaveChain = useRef(Promise.resolve());
  const activeSettingsSave = useRef(null);
  function saveSettings(botId, patch) {
    if (!draft) {
      const next = settingsSaveChain.current
        .catch(() => {})
        .then(() => invoke("setComposerSettings", { chatId: chat.id, botId, ...patch }));
      settingsSaveChain.current = next;
      activeSettingsSave.current = next;
      next.then(
        () => {
          if (activeSettingsSave.current === next) activeSettingsSave.current = null;
        },
        () => {
          if (activeSettingsSave.current === next) activeSettingsSave.current = null;
        },
      );
      return next;
    }
    const accountId = members.find(member => member.id === botId)?.accountId;
    const provider = accounts.find(account => account.id === accountId)?.provider;
    setSettingsByBot(previous => {
      const settings = { ...previous[botId], ...patch };
      if (state.permissionModes?.[provider]?.includes("plan")) {
        if (patch.planMode) settings.permission = "plan";
        else if (patch.planMode === false && settings.permission === "plan") settings.permission = "default";
        if (patch.permission !== undefined || patch.planMode !== undefined) settings.planMode = settings.permission === "plan";
      }
      return { ...previous, [botId]: settings };
    });
  }
  function firstMessage(payload) {
    const forMembers = values => Object.fromEntries(
      Object.entries(values).filter(([botId]) => draft.members.includes(botId)),
    );
    return invoke("sendDraft", {
      draft, settings: forMembers(settingsByBot), pausedGoals: forMembers(pausedGoals),
      expectedProjectCwd: projectCwd, ...payload,
    });
  }
  async function saveDraftGoal({ action, botId, objective, status }) {
    if (action === "set" && status === "active") {
      const result = await firstMessage({ recipients: [botId], goalObjective: objective });
      suppressDraftSave.current = true;
      if (text || selected.length || Object.keys(extensions).length)
        setComposerDraft(result.chatId, { text, selected, extensions, slashMember });
      deleteComposerDraft(scope);
      return result.chatId;
    }
    setPausedGoals(previous => {
      const next = { ...previous };
      if (action === "clear") delete next[botId];
      else next[botId] = objective;
      return next;
    });
  }
  async function sendMessage(command) {
    if (!canSend || sendLock.current || fileLock.current) return;
    sendLock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!draft && activeSettingsSave.current) {
        await activeSettingsSave.current;
      }
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
      const message = {
        ...(command ? { slash: command } : { nativeActions }),
        ...(firstProject && { expectedProjectCwd: projectCwd }),
        ...(!command && replyToMessageId && { replyToMessageId }),
        text: command
          ? ("/" + command.name + " " + command.arguments).trimEnd()
          : text.trim(),
        recipients: command ? [command.botId] : recipients,
        attachmentIds: files.map((file) => file.id),
      };
      let chatId = chat?.id;
      if (draft) ({ chatId } = await firstMessage(message));
      else await invoke("send", { ...message, chatId });
      suppressDraftSave.current = true;
      deleteComposerDraft(scope);
      setReplyToMessageId(null);
      setFiles([]);
      setPopup(null);
      setText("");
      setSlashMember(null);
      setSelected([]);
      setExtensions({});
      setSettingsByBot({});
      setPausedGoals({});
      setOpen(false);
      setMention(null);
      suppressDraftSave.current = false;
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
    <div className={`composer-area${draft ? " home-composer" : ""}`}>
      <div className="composer-wrap" ref={root}>
        {firstProject && <div className="composer-project-row">
          <FirstChatProject projects={state.projects} {...firstProject} disabled={firstProject.disabled || busy} />
        </div>}
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
            aria-label={tr("选择接收人", "Choose recipients")}
            onKeyDown={moveInMenu}
          >
            <div className="recipient-menu-header">
              <strong>{tr("选择接收人", "Choose recipients")}</strong>
              <IconButton
                icon={X}
                label={tr("关闭接收人列表", "Close recipients")}
                onClick={() => {
                  closeMenu();
                  ref.current?.focus();
                }}
              />
            </div>
            {matchesEveryone && members.length > 0 && (
              <button
                type="button"
                className="recipient-option"
                onClick={() => select(members.map((b) => b.id))}
              >
                <UsersRound size={16} />
                <span>{tr("全体成员", "Everyone")}</span>
                <small>{members.length} {tr("位", " members")}</small>
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
              (!members.length || !matchesEveryone) && (
                <p className="menu-empty">{tr("没有匹配的群成员", "No matching members")}</p>
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
          {replyToMessageId && (
            <div className="quote-card draft-quote" role="group" aria-label={tr("待发送引用", "Quote to send")}>
              {quotedMessage ? <MessageQuote message={quotedMessage} descriptionId={quoteDescriptionId} /> :
                <span id={quoteDescriptionId}>{tr("原消息已不可用，请重新选择引用。", "The original message is unavailable. Choose another quote.")}</span>}
              <IconButton
                icon={X}
                label={tr("移除引用", "Remove quote")}
                disabled={busy}
                onClick={() => {
                  setReplyToMessageId(null);
                  setError("");
                  ref.current?.focus();
                }}
              />
            </div>
          )}
          {files.length > 0 && (
            <div className="attachment-chips" aria-label={tr("待发送附件", "Attachments to send")}>
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
                          {file.fileCount} {tr("个文件", " files")}
                          {file.skippedCount > 0
                            ? tr(` · 已跳过 ${file.skippedCount} 项`, ` · Skipped ${file.skippedCount}`)
                            : ""}
                        </small>
                      )}
                    <button
                      type="button"
                      disabled={workingFiles || busy}
                      aria-label={tr(`移除附件 ${file.name}`, `Remove attachment ${file.name}`)}
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
            <div className="attachment-chips" aria-label={tr("已选插件与技能", "Selected plugins and skills")}>
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
                      aria-label={tr(`移除 ${item.label}`, `Remove ${item.label}`)}
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
                  aria-label={tr(`移除接收人 ${members.find((b) => b.id === id)?.name}`, `Remove recipient ${members.find((b) => b.id === id)?.name}`)}
                  title={tr("移除接收人", "Remove recipient")}
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
                ? tr("此对话的 Bot 已归档", "The bot in this chat is archived")
                : isGroup
                  ? tr("输入消息，使用 @ 选择接收人…", "Write a message, use @ to choose recipients…")
                  : tr(`和 ${members[0].name} 一起工作`, `Work with ${members[0].name}`)
            }
            disabled={!members.length}
            readOnly={busy}
            autoFocus
            maxLength={200000}
            aria-label={draft ? tr("新对话消息", "New chat message") : tr("消息内容", "Message")}
            aria-describedby={replyToMessageId ? quoteDescriptionId : undefined}
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
              bot={inspectedBot}
              actionCatalog={actions}
              onInspect={id => {
                setInspected({ recipients: recipientKey, id });
                if (popup?.botId) setPopup({ ...popup, botId: id });
                if (slash.match && slashTarget) setSlashMember(id);
              }}
              filesDisabled={
                !members.length || workingFiles || !filesReady || busy
              }
              onFiles={pickFiles}
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
              onGoal={bot => setSlashDialog({ action: "goal", bot })}
              selectedExtensions={extensions}
              chatId={chat?.id}
              state={state}
              members={members}
              isGroup={isGroup}
              invoke={invoke}
              saveSettings={saveSettings}
              draftSettings={draft ? settingsByBot : null}
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
                  title={tr("选择接收人", "Choose recipients")}
                  aria-label={tr("选择接收人", "Choose recipients")}
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
              aria-label={stopping ? tr("停止当前对话任务", "Stop current task") : tr("发送消息", "Send message")}
              title={stopping ? tr("停止当前对话任务", "Stop current task") : tr("发送消息", "Send message")}
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
        {slashDialog?.action === "goal" && createPortal(
          <GoalDialog
            bot={slashDialog.bot}
            initialObjective={slashDialog.args}
            chatId={chat?.id}
            draftGoal={pausedGoals[slashDialog.bot.id]}
            onDraftSave={saveDraftGoal}
            invoke={invoke}
            onStarted={draft ? onSent : undefined}
            onClose={() => setSlashDialog(null)}
          />, document.body,
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
            title={snippetType === "editor" ? tr("附加编辑器选区", "Attach editor selection") : tr("添加文本", "Add text")}
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
                          ? tr("编辑器选区.txt", "Editor selection.txt")
                          : tr("添加的文本.txt", "Attached text.txt"),
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
                aria-label={tr("文本内容", "Text content")}
                placeholder={
                  snippetType === "editor"
                    ? tr("从编辑器复制选区，然后粘贴到这里", "Copy a selection from your editor and paste it here")
                    : tr("输入或粘贴文本", "Type or paste text")
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
                  {tr("取消", "Cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  busy={workingFiles}
                  disabled={!snippet.trim()}
                >
                  {tr("添加到消息", "Add to message")}
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
                if (!blob) throw new Error(tr("无法导出草图，请重试。", "Could not export the sketch. Try again."));
                await addFiles([
                  {
                    name: tr("草图.png", "Sketch.png"),
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
            (ambiguous ? tr("群中有同名 Bot，请从接收人列表中按账号选择。", "Multiple bots share this name. Choose a recipient by account.") : "")}
        </Notice>
      </div>
    </div>
  );
}
