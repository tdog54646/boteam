import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { WorkspacePanel } from "./WorkspacePanel";
import { listSubagents } from "./Subagents";
import { Onboarding } from "./Onboarding";
import { Sidebar, ChatSearch } from "./Sidebar";
import { ProjectActionDialog, ProjectDialog } from "./ProjectDialog";
import { Home } from "./Home";
import { hasComposerDraft, pruneComposerDrafts } from "./composerDrafts";
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_KEY,
  PaneResizer,
  readStoredPaneWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  writeStoredPaneWidth,
} from "./PaneResizer";
import { Button, errorText, IconButton, Modal, Notice, Spinner } from "./ui";

const empty = {
  accounts: [],
  bots: [],
  chats: [],
  chatSections: [],
  projects: [],
  messages: [],
  tasks: [],
  onboarded: false,
};
const invoke = (method, payload = {}) => window.boteam.invoke(method, payload);
const initialChat = window.boteam?.initialChatId;
const navigationStorage = initialChat ? sessionStorage : localStorage;
const builtInPages = new Set(["home", "accounts", "bots"]);
const defaultBotKey = "boteam:quick-bot";
const draftStorageKey = "boteam:chat-drafts";
function invokeWithDraft(draft, method, payload = {}) {
  if (draft && method === "attachmentPreview")
    return invoke(method, { ...payload, chatId: draft.legacyHome ? "home:" + draft.members[0] : "draft:" + draft.id });
  if (draft && (method.startsWith("panel") || ["composerActions", "slashInfo"].includes(method)))
    return invoke(method, { ...payload, chatId: undefined, draft });
  return invoke(method, payload);
}
function readDrafts() {
  try {
    const raw = localStorage.getItem(draftStorageKey) ?? sessionStorage.getItem(draftStorageKey);
    const saved = JSON.parse(raw);
    return Object.fromEntries(Object.entries(saved || {}).filter(([key, draft]) =>
      draft && typeof draft.id === "string" && ["direct", "group"].includes(draft.kind) &&
      Array.isArray(draft.members) && draft.members.length && draft.members.every(id => typeof id === "string") &&
      (key === "draft:" + draft.id || (draft.legacyHome && key === "home:" + draft.members[0]))));
  } catch { return {}; }
}
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
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredPaneWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    readStoredPaneWidth(PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
  );
  const shellRef = useRef(null);
  const [homeSelection, setHomeSelection] = useState(() => localStorage.getItem(defaultBotKey) || "");
  const homeBot = state.bots.find(b => !b.archived && b.id === homeSelection) || state.bots.find(b => !b.archived);
  const [panel, setPanel] = useState(null);
  const panelSequence = useRef(0);
  const sourceControl = useRef(null);
  const [sourceDraft, setSourceDraft] = useState(null);
  const [drafts, setDrafts] = useState(readDrafts);
  const draftPages = useRef(drafts);
  const updateDraft = useCallback((key, draft) => {
    const next = { ...draftPages.current };
    if (draft) next[key] = draft;
    else delete next[key];
    draftPages.current = next;
    setDrafts(next);
    try {
      localStorage.setItem(draftStorageKey, JSON.stringify(next));
      sessionStorage.removeItem(draftStorageKey);
    } catch {}
  }, []);
  const homeKey = homeBot && "home:" + homeBot.id;
  const draftKey = page === "home" ? homeKey : page;
  const draft = drafts[draftKey];
  const currentDraftId = useRef(null);
  currentDraftId.current = draft?.id;
  const [projectBusy, setProjectBusy] = useState(false);
  const currentPage = useRef(page);
  currentPage.current = page;
  const trail = useRef([page]);
  const [position, setPosition] = useState(0);
  const historyPosition = useRef(0);
  const latest = useRef(empty);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const hasLaunched = useRef(false);
  function chooseHomeBot(id) {
    localStorage.setItem(defaultBotKey, id);
    setHomeSelection(id);
    if (draft && !draft.legacyHome && draft.kind === "direct") {
      updateDraft(draftKey, { ...draft, members: [id] });
    }
  }
  useEffect(() => {
    if (page === "home" && homeKey && state.onboarded && !draftPages.current[homeKey])
      updateDraft(homeKey, { id: crypto.randomUUID(), kind: "direct", members: [homeBot.id], legacyHome: true });
  }, [page, homeKey, homeBot?.id, state.onboarded, draft, updateDraft]);
  useEffect(() => {
    function syncSelection(event) {
      if (event.storageArea !== localStorage) return;
      if (event.key === defaultBotKey || event.key === null)
        setHomeSelection(localStorage.getItem(defaultBotKey) || "");
      if (event.key === draftStorageKey || event.key === null) {
        const next = readDrafts();
        draftPages.current = next;
        setDrafts(next);
      }
      if (event.key === SIDEBAR_WIDTH_KEY || event.key === null)
        setSidebarWidth(readStoredPaneWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
      if (event.key === PANEL_WIDTH_KEY || event.key === null)
        setPanelWidth(readStoredPaneWidth(PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH));
    }
    window.addEventListener("storage", syncSelection);
    return () => window.removeEventListener("storage", syncSelection);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const snapshot = await invoke("snapshot");
    if (request === revision.current) {
      const before = latest.current;
      latest.current = snapshot;
      if (!hasLaunched.current) {
        hasLaunched.current = true;
        const lastPage = navigationStorage.getItem("boteam:page");
        // A reload can interrupt navigation after the first message has committed.
        const savedIds = new Set(snapshot.chats.map(chat => chat.id));
        const activeBots = snapshot.bots.filter(bot => !bot.archived);
        const defaultBot = activeBots.find(bot => bot.id === localStorage.getItem(defaultBotKey)) || activeBots[0];
        for (const [key, candidate] of Object.entries(draftPages.current)) {
          if (!savedIds.has(candidate.id)) continue;
          updateDraft(key, null);
          if (currentPage.current === key || (currentPage.current === "home" && key === "home:" + defaultBot?.id)) {
            trail.current = [candidate.id];
            currentPage.current = candidate.id;
            setPage(candidate.id);
            navigationStorage.setItem("boteam:page", candidate.id);
          }
        }
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
      const savedChatIds = new Set(snapshot.chats.map(c => c.id));
      const draftKeys = new Set(Object.keys(draftPages.current));
      pruneComposerDrafts(savedChatIds, draftKeys);
      const accessible = new Set([...builtInPages, ...draftKeys, ...savedChatIds]);
      setDialog(current => (current?.type === "project" || current?.type === "projectAction") && current.id &&
        !snapshot.projects?.some(project => project.id === current.id) ? null : current);
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
  }, [updateDraft]);
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
  async function finishDraft(chatId) {
    try { await refresh(); } catch (e) { setError(errorText(e)); }
    const here = currentPage.current === page && currentDraftId.current === chatId;
    if (draftPages.current[draftKey]?.id === chatId) updateDraft(draftKey, null);
    // Back/forward should open the saved conversation in place of its draft.
    if (page !== "home") trail.current = trail.current.map(id => id === page ? chatId : id);
    if (here) {
      trail.current[historyPosition.current] = chatId;
      visit(chatId);
    }
  }
  const startDraft = useCallback(spec => {
    const id = crypto.randomUUID();
    const key = "draft:" + id;
    updateDraft(key, { ...spec, id });
    setError("");
    select(key);
  }, [select, updateDraft]);
  const startDirect = useCallback(
    (botId, projectId) => startDraft({ kind: "direct", members: [botId], ...(projectId && { projectId }) }),
    [startDraft],
  );
  const defaultBotId = homeBot?.id;
  const newChat = useCallback(projectId => {
    if (!defaultBotId) {
      select("home");
      return;
    }
    const targetProject = projectId || null;
    const currentHomeKey = "home:" + defaultBotId;
    const homeCandidate = draftPages.current[currentHomeKey];
    if (homeCandidate && hasComposerDraft(currentHomeKey) && (homeCandidate.projectId || null) === targetProject) {
      setError("");
      select("home");
      return;
    }
    const existing = Object.entries(draftPages.current)
      .reverse()
      .find(([k, d]) => k.startsWith("draft:") && d.kind === "direct" && !d.legacyHome && (d.projectId || null) === targetProject);
    if (existing) {
      const [existingKey, existingDraft] = existing;
      if (existingDraft.members[0] !== defaultBotId) {
        updateDraft(existingKey, { ...existingDraft, members: [defaultBotId] });
      }
      setError("");
      select(existingKey);
      return;
    }
    startDirect(defaultBotId, projectId);
  }, [defaultBotId, startDirect, select, updateDraft]);
  async function finishWizard(botId) {
    setBusy(true);
    try {
      await invoke("finishOnboarding");
      await refresh();
      if (botId) startDirect(botId);
      else select("home");
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
      if (key === "n") newChat();
      if (key === "k") setDialog({ type: "search" });
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [ready, state.onboarded, dialog, newChat]);
  const wizard = ready && !state.onboarded;
  const chat = state.chats.find((c) => c.id === page);
  const agents = useMemo(() => listSubagents(chat?.id, state.tasks, state.bots, state.accounts),
    [chat?.id, state.tasks, state.bots, state.accounts]);
  const nativeAgents = agents.filter(agent => agent.id.startsWith("agy:"));
  const watchNativeAgents = nativeAgents.some(agent => ["pendingInit", "dispatched", "running", "unconfirmed"].includes(agent.status));
  useEffect(() => {
    if (!chat?.id || !nativeAgents.length) return;
    const deadline = performance.now() + 120_000;
    let disposed = false, timer;
    async function refreshAgents() {
      await invoke("refreshSubagents", { chatId: chat.id }).catch(() => {});
      if (!disposed && watchNativeAgents && performance.now() < deadline) timer = setTimeout(refreshAgents, 2400);
    }
    void refreshAgents();
    return () => { disposed = true; clearTimeout(timer); };
  }, [chat?.id, nativeAgents.length, watchNativeAgents]);
  useEffect(() => { document.title = chat ? chat.name + " · BoTeam" : "BoTeam"; }, [chat?.name]);
  const panelMembers = (chat?.members || draft?.members || [])
    .map(id => state.bots.find(b => b.id === id)).filter(b => b && !b.archived);
  const workPage = ready && !wizard && Boolean(chat || draft || page === "home");
  const panelKey = chat?.id || draft?.id || "home";
  const panelVisible = Boolean(workPage && panel?.key === panelKey && panel.visible);
  const initialProjectId = chat ? chat.projectId : draft?.projectId;
  const project = state.projects.find(p => p.id === initialProjectId);
  const panelCwd = chat ? chat.initialProjectCwd ?? null : draft?.folder || project?.folders[0] || null;
  const panelScope = JSON.stringify([panelKey, panelCwd]);
  const invokeDraft = useCallback((method, payload) => invokeWithDraft(draft, method, payload), [draft]);
  // Keep the terminal transport stable when a draft's UUID becomes the saved chat ID.
  const invokePanel = useCallback((method, payload = {}) => {
    const pending = draftPages.current["draft:" + payload.chatId] || draftPages.current["home:" + payload.botId];
    return invokeWithDraft(pending?.id === payload.chatId ? pending : null, method, payload);
  }, []);
  async function selectInitialProject(projectId) {
    setError("");
    if (draft) {
      const previous = draftPages.current[draftKey];
      if (previous?.id === draft.id) updateDraft(draftKey, { ...previous, projectId, folder: undefined });
      return;
    }
    setProjectBusy(true);
    try {
      await invoke("setInitialChatProject", { chatId: chat.id, projectId, expectedProjectId: initialProjectId ?? null,
        expectedProjectCwd: chat.initialProjectCwd });
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setProjectBusy(false); }
  }
  async function createInitialProject() {
    setProjectBusy(true);
    try {
      const folder = await invoke("pickDirectory");
      if (folder && currentPage.current === page && (!draft || currentDraftId.current === draft.id)) {
        setDialog({ type: "project", initialFolder: folder,
          initialChat: chat && { chatId: chat.id, expectedProjectId: initialProjectId ?? null,
            expectedProjectCwd: chat.initialProjectCwd },
          onCreated: draft ? selectInitialProject : undefined });
      }
    } catch (e) { setError(errorText(e)); }
    finally { setProjectBusy(false); }
  }
  const firstProject = (chat ? chat.canSelectInitialProject : draft) && {
    projectId: initialProjectId, onSelect: selectInitialProject, onCreate: createInitialProject, disabled: projectBusy,
  };
  function showPanel(request) {
    setPanel({ key: panelKey, visible: true, expanded: false,
      request: request && { ...request, id: ++panelSequence.current } });
  }
  useEffect(() => {
    if (chat && !chat.archived) navigationStorage.setItem("boteam:last-chat", chat.id);
  }, [chat?.id, chat?.archived]);
  const dialogBot = dialog?.id && state.bots.find((b) => b.id === dialog.id);
  const dialogAccount =
    dialog?.id && state.accounts.find((a) => a.id === dialog.id);
  const dialogProject = dialog?.id && state.projects.find(p => p.id === dialog.id);
  const draftTitle = draft && !draft.legacyHome && (draft.name || (draft.kind === "group" ? "新群聊" : panelMembers[0]?.name));
  const pageTitle = wizard
    ? "初始设置"
    : page === "bots"
      ? "Bot 管理"
      : page === "accounts"
        ? "账号管理"
        : chat?.name || draftTitle || "新对话";
  const shellClasses = [
    "shell",
    collapsed ? "sidebar-closed" : "",
    sidebarWidth != null ? "has-custom-rail" : "",
    panelWidth != null ? "has-custom-panel" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const shellStyle = {
    ...(sidebarWidth != null ? { "--custom-rail-width": `${sidebarWidth}px` } : {}),
    ...(panelWidth != null ? { "--custom-panel-width": `${panelWidth}px` } : {}),
    "--active-rail-width": collapsed ? "0px" : "var(--rail-width)",
  };
  const getLeftResizerBounds = () => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1260;
    const panelRect =
      workPage && panelVisible && !panel?.expanded && vw >= 900
        ? shellRef.current?.querySelector(".workspace-panel")?.getBoundingClientRect()
        : null;
    const reservedRight = panelRect ? Math.min(panelRect.width, Math.floor(vw * 0.48)) : 0;
    return {
      min: SIDEBAR_MIN_WIDTH,
      max: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(vw * 0.44), vw - reservedRight - 300)),
    };
  };
  const getRightResizerBounds = () => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1260;
    const sidebarRect = !collapsed ? shellRef.current?.querySelector(".sidebar")?.getBoundingClientRect() : null;
    const reservedLeft = sidebarRect ? sidebarRect.width : 0;
    return {
      min: PANEL_MIN_WIDTH,
      max: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, vw - reservedLeft - 300)),
    };
  };
  return (
    <div ref={shellRef} className={shellClasses} style={shellStyle}>
      {!collapsed && (
        <>
          <Sidebar
            state={state}
            invoke={invoke}
            refresh={refresh}
            onNewChat={newChat}
            dialogOpen={Boolean(dialog)}
            homeBot={homeBot}
            onSelectBot={chooseHomeBot}
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
          <PaneResizer
            side="left"
            label="调整侧边栏宽度"
            value={sidebarWidth}
            min={SIDEBAR_MIN_WIDTH}
            max={SIDEBAR_MAX_WIDTH}
            getBounds={getLeftResizerBounds}
            onResize={(next, commit) => {
              setSidebarWidth(next);
              if (commit) writeStoredPaneWidth(SIDEBAR_WIDTH_KEY, next);
            }}
            onReset={() => {
              setSidebarWidth(null);
              writeStoredPaneWidth(SIDEBAR_WIDTH_KEY, null);
            }}
          />
        </>
      )}
      <main className="main" hidden={panelVisible && panel.expanded}>
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
            {!wizard && (chat || draft)?.kind === "group" && (
              <button
                className="header-action"
                onClick={() => setDialog({ type: chat ? "group" : "draftGroup", id: (chat || draft).id })}
                aria-label="群聊设置"
                title="群聊设置"
              >
                <UsersRound size={15} />
                {(chat || draft).members.length} 位成员
              </button>
            )}
            {workPage && <ChatToolbar key={panelKey} chat={chat} draftChat={draft?.legacyHome ? null : draft} members={panelMembers} state={state} agents={agents}
              invoke={draft ? invokeDraft : invoke} draft={chat?.archived ? null : sourceDraft} pickSource={() => sourceControl.current?.pickFiles()} onChatMenu={actions.showMenu} onChatAction={actions.act}
              menuOpen={actions.menu?.variant === "header"}
              workspaceVisible={panelVisible} toggleWorkspace={() => showPanel()} openWorkspace={showPanel} />}
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
            sourceControl={sourceControl}
            onDraftFiles={setSourceDraft}
            onOpenChat={finishChat}
            onNewDraft={startDraft}
            openWorkspace={showPanel}
            key={chat.id}
            chat={chat}
            firstProject={firstProject}
            state={state}
            invoke={invoke}
            open={setDialog}
          />
        ) : (
          <Home
            key={panelKey}
            draft={draft}
            members={panelMembers}
            firstProject={firstProject}
            setSelection={page === "home" ? chooseHomeBot : undefined}
            state={state}
            invoke={invokeDraft}
            open={setDialog}
            onSent={finishDraft}
            onNewDraft={startDraft}
            sourceControl={sourceControl}
            onDraftFiles={setSourceDraft}
          />
        )}
      </main>
      {workPage && panelVisible && !panel?.expanded && (
        <PaneResizer
          side="right"
          label="调整右侧面板宽度"
          value={panelWidth}
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          getBounds={getRightResizerBounds}
          onResize={(next, commit) => {
            setPanelWidth(next);
            if (commit) writeStoredPaneWidth(PANEL_WIDTH_KEY, next);
          }}
          onReset={() => {
            setPanelWidth(null);
            writeStoredPaneWidth(PANEL_WIDTH_KEY, null);
          }}
        />
      )}
      {workPage && <WorkspacePanel key={panelScope} draftScope={panelScope} initialProjectCwd={panelCwd}
        chatId={chat?.id || draft?.id} botId={panelMembers[0]?.id} bots={panelMembers} agents={agents}
        visible={panelVisible} expanded={panelVisible && panel.expanded}
        request={panel?.key === panelKey ? panel.request : null} invoke={invokePanel}
        onClose={() => setPanel(previous => ({ ...previous, visible: false, expanded: false }))}
        onToggleExpanded={() => setPanel(previous => ({ ...previous, expanded: !previous.expanded }))} />}
      {actions.menuChat && !dialog && <ChatActionMenu key={actions.menu.chatId + actions.menu.variant}
        anchor={actions.menu.anchor} variant={actions.menu.variant} chat={actions.menuChat}
        sections={state.chatSections} projects={state.projects} openTargets={actions.openTargets} onAction={actions.act} onClose={actions.closeMenu} />}
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
      {dialog?.type === "project" && (!dialog.id || dialogProject) && (
        <ProjectDialog key={dialog.id || "import"} project={dialogProject} initialChat={dialog.initialChat}
          initialFolder={dialog.initialFolder} invoke={invoke} onDone={async createdId => {
            if (createdId) await dialog.onCreated?.(createdId);
            try { await refresh(); } catch (e) { setError(errorText(e)); }
            setDialog(current => current === dialog ? (dialog.returnTo || null) : current);
          }} onClose={close} />
      )}
      {dialog?.type === "projectAction" && dialogProject && (
        <ProjectActionDialog key={dialog.id + dialog.action} project={dialogProject} action={dialog.action}
          expectedChatIds={dialog.expectedChatIds} invoke={invoke} onDone={finishDialog} onClose={close} />
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
      {(dialog?.type === "chat" || dialog?.type === "group" || dialog?.type === "draftGroup") && (
        <ChatDialog
          initialProjectId={dialog.projectId}
          chat={
            dialog.type === "group"
              ? state.chats.find((c) => c.id === dialog.id)
              : dialog.type === "draftGroup" && draft?.id === dialog.id ? { ...draft, name: draft.name || "新群聊" } : undefined
          }
          {...state}
          invoke={invoke}
          onDone={finishChat}
          onNewDraft={startDraft}
          onEditDraft={dialog.type === "draftGroup" ? changes => {
            if (draftPages.current[draftKey]?.id === dialog.id) updateDraft(draftKey, { ...draft, ...changes });
            close();
          } : undefined}
          onClose={close}
          newBot={draft => setDialog({ type: "bot", returnTo: { ...dialog, ...draft } })}
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
