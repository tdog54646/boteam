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
import { Onboarding } from "./Onboarding";
import { Sidebar, ChatSearch } from "./Sidebar";
import { Home } from "./Home";
import { Button, errorText, IconButton, Modal, Notice, Spinner } from "./ui";

const empty = {
  accounts: [],
  bots: [],
  chats: [],
  messages: [],
  tasks: [],
  onboarded: false,
};
const invoke = (method, payload = {}) => window.boteam.invoke(method, payload);
export default function App() {
  const [state, setState] = useState(empty);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(
    () => localStorage.getItem("boteam:page") || "home",
  );
  const [dialog, setDialog] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const trail = useRef([page]);
  const [position, setPosition] = useState(0);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const hasLaunched = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const snapshot = await invoke("snapshot");
    if (request === revision.current) {
      if (!hasLaunched.current) {
        hasLaunched.current = true;
        const lastPage = localStorage.getItem("boteam:page");
        if (
          snapshot.onboarded &&
          ["accounts", "bots"].includes(lastPage) &&
          snapshot.bots.some((bot) => !bot.archived)
        ) {
          const lastChat = localStorage.getItem("boteam:last-chat");
          const activeBots = new Set(snapshot.bots.filter((bot) => !bot.archived).map((bot) => bot.id));
          const usable = snapshot.chats.filter((chat) => chat.members.some((id) => activeBots.has(id)));
          const target = usable.find((chat) => chat.id === lastChat)?.id || usable[0]?.id || "home";
          trail.current = [target];
          setPage(target);
          localStorage.setItem("boteam:page", target);
        }
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
  function move(direction) {
    const index = position + direction;
    if (index < 0 || index >= trail.current.length) return;
    setPosition(index);
    const id = trail.current[index];
    setPage(id);
    localStorage.setItem("boteam:page", id);
    setDialog(null);
  }
  function select(id) {
    if (trail.current[position] !== id) {
      trail.current = [...trail.current.slice(0, position + 1), id];
      setPosition(trail.current.length - 1);
    }
    setPage(id);
    localStorage.setItem("boteam:page", id);
    setDialog(null);
  }
  const close = () => setDialog(null);
  async function finishDialog() {
    await refresh();
    setDialog((current) => current === dialog ? null : current);
  }
  async function finishChat(id) {
    await refresh();
    select(id);
  }
  async function startDirect(id) {
    try {
      const chatId = await invoke("createChat", {
        kind: "direct",
        members: [id],
      });
      await finishChat(chatId);
    } catch (e) {
      setError(errorText(e));
    }
  }
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
      if (!(e.metaKey || e.ctrlKey) || !ready || !state.onboarded || dialog)
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
  }, [ready, state.onboarded, dialog, position]);
  const wizard = ready && !state.onboarded;
  const chat = state.chats.find((c) => c.id === page);
  useEffect(() => {
    if (chat) localStorage.setItem("boteam:last-chat", chat.id);
  }, [chat?.id]);
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
            onOpenChat={finishChat}
            key={chat.id}
            chat={chat}
            state={state}
            invoke={invoke}
            open={setDialog}
          />
        ) : (
          <Home
            state={state}
            invoke={invoke}
            open={setDialog}
            onChat={finishChat}
          />
        )}
      </main>
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
                  onClick={() => setDialog({ type: "import" })}
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
