import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  PanelLeftOpen,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { AccountDialog, AccountList, Discovery, LoginDialog } from "./Accounts";
import { BotForm, BotList, ChatDialog } from "./Bots";
import { Conversation } from "./Conversation";
import { ChatToolbar } from "./ChatToolbar";
import { ChatActionMenu } from "./ChatActionMenu";
import { ChatActionDialog, useChatActions } from "./ChatActions";
import "./chat-management.css";
import { Onboarding } from "./Onboarding";
import { Sidebar, ChatSearch } from "./Sidebar";
import { Home } from "./Home";
import { Button, errorText, IconButton, Modal, Notice, Spinner } from "./ui";

const empty = {
  accounts: [],
  bots: [],
  chats: [],
  chatSections: [],
  messages: [],
  tasks: [],
  onboarded: false,
};
const invoke = (method, payload = {}) => window.boteam.invoke(method, payload);
const initialChat = window.boteam?.initialChatId;
const navigationStorage = initialChat ? sessionStorage : localStorage;
const builtInPages = new Set(["home", "accounts", "bots"]);
export default function App() {
  const [state, setState] = useState(empty);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(
    () => navigationStorage.getItem("boteam:page") || initialChat || "home",
  );
  const [dialog, setDialog] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const currentPage = useRef(page);
  currentPage.current = page;
  const trail = useRef([page]);
  const [position, setPosition] = useState(0);
  const historyPosition = useRef(0);
  const latest = useRef(empty);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const hasLaunched = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const snapshot = await invoke("snapshot");
    if (request === revision.current) {
      const before = latest.current;
      latest.current = snapshot;
      if (!hasLaunched.current) {
        hasLaunched.current = true;
        const lastPage = navigationStorage.getItem("boteam:page");
        if (
          !initialChat && snapshot.onboarded &&
          ["accounts", "bots"].includes(lastPage) &&
          snapshot.bots.some((bot) => !bot.archived)
        ) {
          const lastChat = navigationStorage.getItem("boteam:last-chat");
          const activeBots = new Set(snapshot.bots.filter((bot) => !bot.archived).map((bot) => bot.id));
          const usable = snapshot.chats.filter((chat) => !chat.archived && chat.members.some((id) => activeBots.has(id)));
          const target = usable.find((chat) => chat.id === lastChat)?.id || usable[0]?.id || "home";
          trail.current = [target];
          currentPage.current = target;
          setPage(target);
          navigationStorage.setItem("boteam:page", target);
        }
        const opened = snapshot.chats.find(chat => chat.id === currentPage.current);
        if (initialChat && opened?.unread) {
          invoke("setChatUnread", { chatId: opened.id, unread: false }).catch(e => setError(errorText(e)));
        }
      }
      const accessible = new Set([...builtInPages, ...snapshot.chats.map(c => c.id)]);
      const retired = new Set(before.chats.filter(c => !accessible.has(c.id)).map(c => c.id));
      for (const c of snapshot.chats) if (c.archived) retired.add(c.id);
      if (retired.size) {
        setDialog(current => current && ["chatAction", "directory", "group"].includes(current.type)
          && !accessible.has(current.id) ? null : current);
      }
      const previous = trail.current;
      const valid = previous.filter(id => accessible.has(id));
      let index = previous.slice(0, historyPosition.current + 1).filter(id => accessible.has(id)).length - 1;
      if (!accessible.has(currentPage.current)) {
        const fallback = valid[index] || "home";
        if (index < 0) { valid.unshift(fallback); index = 0; }
        currentPage.current = fallback;
        setPage(fallback);
        navigationStorage.setItem("boteam:page", fallback);
      }
      if (valid.length !== previous.length || index !== historyPosition.current || valid[0] !== previous[0]) {
        trail.current = valid;
        historyPosition.current = Math.max(0, index);
        setPosition(historyPosition.current);
      }
      setState({ ...empty, ...snapshot });
      setReady(true);
      setLoadError("");
    }
    return snapshot;
  }, []);
  useEffect(() => {
    if (!window.boteam) {
      setLoadError("请从 BoTeam 桌面应用打开工作台。");
      return;
    }
    refresh().catch((e) => setLoadError(errorText(e)));
    return window.boteam.subscribe(() =>
      refresh().catch((e) => setError(errorText(e))),
    );
  }, [refresh]);
  const visit = useCallback(id => {
    currentPage.current = id;
    setPage(id);
    navigationStorage.setItem("boteam:page", id);
    setDialog(null);
    if (latest.current.chats.find(chat => chat.id === id)?.unread) {
      invoke("setChatUnread", { chatId: id, unread: false }).catch(e => setError(errorText(e)));
    }
  }, []);
  function move(direction) {
    const index = historyPosition.current + direction;
    if (index < 0 || index >= trail.current.length) return;
    historyPosition.current = index;
    setPosition(index);
    visit(trail.current[index]);
  }
  const select = useCallback(id => {
    const index = historyPosition.current;
    if (trail.current[index] !== id) {
      trail.current = [...trail.current.slice(0, index + 1), id];
      historyPosition.current = trail.current.length - 1;
      setPosition(historyPosition.current);
    }
    visit(id);
  }, [visit]);
  useEffect(() => window.boteam?.onOpenChat?.(select), [select]);
  const actions = useChatActions({ state, page, currentPage, dialog, setDialog, invoke, select, refresh, setError });
  const close = () => setDialog(current => current?.returnTo || null);
  async function finishDialog() {
    await refresh();
    setDialog((current) => current === dialog ? (dialog?.returnTo || null) : current);
  }
  async function finishChat(id) {
    try { await refresh(); } catch (e) {
      setError(errorText(e));
      if (!latest.current.chats.some(c => c.id === id)) return;
    }
    select(id);
  }
  const startDirect = useCallback(async botId => {
    try {
      const id = await invoke("createChat", { kind: "direct", members: [botId] });
      await refresh();
      select(id);
    } catch (e) { setError(errorText(e)); }
  }, [refresh, select]);
  async function finishWizard(botId) {
    setBusy(true);
    try {
      let id = "home";
      if (botId)
        id = await invoke("createChat", { kind: "direct", members: [botId] });
      await invoke("finishOnboarding");
      await refresh();
      select(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    function key(e) {
      if (e.defaultPrevented || e.repeat || e.shiftKey || e.altKey ||
          !(e.metaKey || e.ctrlKey) || !ready || !state.onboarded || dialog)
        return;
      const key = e.key.toLowerCase();
      if (!["b", "k", "n"].includes(key)) return;
      e.preventDefault();
      if (key === "b") setCollapsed((value) => !value);
      if (key === "n") select("home");
      if (key === "k") setDialog({ type: "search" });
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [ready, state.onboarded, dialog, select]);
  const wizard = ready && !state.onboarded;
  const chat = state.chats.find((c) => c.id === page);
  useEffect(() => { document.title = chat ? chat.name + " · BoTeam" : "BoTeam"; }, [chat?.name]);
  useEffect(() => {
    if (chat && !chat.archived) navigationStorage.setItem("boteam:last-chat", chat.id);
  }, [chat?.id, chat?.archived]);
  const dialogBot = dialog?.id && state.bots.find((b) => b.id === dialog.id);
  const dialogAccount =
    dialog?.id && state.accounts.find((a) => a.id === dialog.id);
  const pageTitle = wizard
    ? "初始设置"
    : page === "bots"
      ? "Bot 管理"
      : page === "accounts"
        ? "账号管理"
        : chat?.name || "新对话";
  return (
    <div className={`shell ${collapsed ? "sidebar-closed" : ""}`}>
      {!collapsed && (
        <Sidebar
          state={state}
          onChatMenu={actions.showMenu}
          onChatAction={actions.act}
          menuChatId={actions.menu?.variant === "context" ? actions.menu.chatId : null}
          page={page}
          select={select}
          open={setDialog}
          disabled={wizard || !ready}
          collapse={() => setCollapsed(true)}
          history={{
            back: position > 0,
            forward: position + 1 < trail.current.length,
            move,
          }}
        />
      )}
      <main className="main">
        <header className="topbar">
          {collapsed && (
            <IconButton
              icon={PanelLeftOpen}
              label="展开侧栏"
              onClick={() => setCollapsed(false)}
            />
          )}
          <div className="window-title">{pageTitle}</div>
          <div className="header-actions">
            {!wizard && chat?.kind === "group" && (
              <button
                className="header-action"
                onClick={() => setDialog({ type: "group", id: chat.id })}
                aria-label="群聊设置"
                title="群聊设置"
              >
                <UsersRound size={15} />
                {chat.members.length} 位成员
              </button>
            )}
            {chat && <ChatToolbar chat={chat} onChatMenu={actions.showMenu} onChatAction={actions.act}
              menuOpen={actions.menu?.variant === "header"} />}
          </div>
        </header>
        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            <IconButton
              label="关闭提示"
              icon={X}
              onClick={() => setError("")}
            />
          </div>
        )}
        {!ready ? (
          <div className="startup">
            {loadError ? (
              <>
                <CircleAlert size={25} />
                <p>{loadError}</p>
                {window.boteam && (
                  <Button
                    onClick={() =>
                      refresh().catch((e) => setLoadError(errorText(e)))
                    }
                  >
                    重试
                  </Button>
                )}
              </>
            ) : (
              <Spinner size={22} />
            )}
          </div>
        ) : wizard ? (
          <Onboarding
            state={state}
            invoke={invoke}
            refresh={refresh}
            finishWizard={finishWizard}
            busy={busy}
          />
        ) : page === "accounts" ? (
          <div className="page-scroll">
            <AccountList
              accounts={state.accounts}
              bots={state.bots}
              open={setDialog}
            />
          </div>
        ) : page === "bots" ? (
          <div className="page-scroll">
            <BotList {...state} open={setDialog} startDirect={startDirect} />
          </div>
        ) : chat ? (
          <Conversation
            onError={setError}
            restoreChat={() => actions.act("archive", chat)}
            onOpenChat={finishChat}
            key={chat.id}
            chat={chat}
            state={state}
            invoke={invoke}
            open={setDialog}
          />
        ) : (
          <Home state={state} invoke={invoke} open={setDialog} onChat={finishChat} />
        )}
      </main>
      {actions.menuChat && !dialog && <ChatActionMenu key={actions.menu.chatId + actions.menu.variant}
        anchor={actions.menu.anchor} variant={actions.menu.variant} chat={actions.menuChat}
        sections={state.chatSections} openTargets={actions.openTargets} onAction={actions.act} onClose={actions.closeMenu} />}
      {actions.notice && <div className="chat-action-status" role="status">{actions.notice}</div>}
      {dialog?.type === "directory" && <Modal title="选择工作目录" onClose={close}>
        <div className="member-list">{dialog.directories.map(({ botId, names, directory }, index) =>
          <button type="button" key={botId} data-autofocus={index === 0 || undefined} className="member-row"
            onClick={() => { close(); actions.act(dialog.action, { id: dialog.id }, { ...dialog.payload, botId }); }}>
            <span className="row-copy"><strong>{names.join("、")}</strong><small title={directory}>{directory}</small></span>
          </button>)}</div>
      </Modal>}
      {dialog?.type === "chatAction" && state.chats.some(c => c.id === dialog.id) && (
        <ChatActionDialog key={dialog.id + dialog.action} chat={state.chats.find(c => c.id === dialog.id)}
          action={dialog.action} invoke={invoke} onClose={close} onDone={finishDialog} />
      )}
      {dialog?.type === "search" && (
        <Modal title="搜索对话" onClose={close}>
          <ChatSearch state={state} select={select} />
        </Modal>
      )}
      {dialog?.type === "import" && (
        <Modal
          title="导入本机账号"
          subtitle="选择原生工具配置，导入已识别的订阅账号。"
          onClose={close}
          wide
        >
          <Discovery invoke={invoke} onFinish={finishDialog} onSkip={close} />
        </Modal>
      )}
      {dialog?.type === "login" && (
        <LoginDialog
          account={dialogAccount}
          invoke={invoke}
          onDone={finishDialog}
          onClose={close}
        />
      )}
      {dialog?.type === "account" && dialogAccount && (
        <AccountDialog
          account={dialogAccount}
          bots={state.bots}
          invoke={invoke}
          onDone={finishDialog}
          onClose={close}
          onLogin={() => setDialog({ type: "login", id: dialogAccount.id })}
        />
      )}
      {dialog?.type === "bot" && (
        <Modal title={dialogBot ? "编辑 Bot" : "创建 Bot"} onClose={close}>
          {state.accounts.length ? (
            <BotForm
              initial={dialogBot}
              accounts={state.accounts}
              invoke={invoke}
              onDone={finishDialog}
              onCancel={close}
              onRemove={
                dialogBot
                  ? () => setDialog({ type: "removeBot", id: dialogBot.id })
                  : undefined
              }
            />
          ) : (
            <>
              <div className="plain-note">
                <UserRound size={18} />
                先连接一个订阅账号，再为 Bot 选择身份。
              </div>
              <div className="form-actions">
                <Button onClick={close}>取消</Button>
                <Button
                  variant="primary"
                  onClick={() => setDialog({ type: "import", returnTo: dialog })}
                >
                  导入账号
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
      {dialog?.type === "removeBot" && dialogBot && (
        <RemoveBot bot={dialogBot} onClose={close} onDone={finishDialog} />
      )}
      {(dialog?.type === "chat" || dialog?.type === "group") && (
        <ChatDialog
          kind={dialog.kind}
          chat={
            dialog.type === "group"
              ? state.chats.find((c) => c.id === dialog.id)
              : undefined
          }
          {...state}
          invoke={invoke}
          onDone={finishChat}
          onClose={close}
          newBot={() => setDialog({ type: "bot" })}
        />
      )}
    </div>
  );
}
function RemoveBot({ bot, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={`移除 ${bot.name}？`}
      subtitle="Bot 将被归档并停止接收新任务，已有聊天记录会保留。"
      onClose={onClose}
    >
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await invoke("removeBot", { id: bot.id });
              await onDone();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          确认移除
        </Button>
      </div>
    </Modal>
  );
}
