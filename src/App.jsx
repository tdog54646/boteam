import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  PanelLeftOpen,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { AccountDialog, AccountList, LocalAccountSettings, Discovery, LoginDialog } from "./Accounts";
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
import { ChannelNavigation, Channels } from "./Channels";
import { ChannelSetupDialog } from "./ChannelSetupDialog";
import { platforms } from "../desktop/channels/catalog.mjs";
import { ScheduleNavigation, SchedulesPage, scheduleCreatePages } from "./Schedules";
import { ArchivedChats, HistoryButtons, SidebarTitlebar, WorkspaceNavigation } from "./WorkspaceNavigation";
import { SettingsNavigation, settingsPages } from "./SettingsNavigation";
import { ProfilePage } from "./ProfilePage";
import { AppSettings } from "./AppSettings";
import { CodingSettings } from "./CodingSettings";
import { DataSettings } from "./DataSettings";
import { IntegrationSettings } from "./IntegrationSettings";
import { usePreferences } from "./preferences";
import { shortcutFromEvent } from "./shortcuts";
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
const builtInPages = new Set(["home", "schedules", "channels", "profile", ...settingsPages, ...scheduleCreatePages]);
const schedulePrefix = "schedule:";
const channelChatPrefix = "channel-chat:";
const normalizePage = id => id === "channel-chats" ? "channels" : id;
const chatIdForPage = page => page.startsWith(channelChatPrefix) ? page.slice(channelChatPrefix.length) : page;
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
  const { t, shortcuts } = usePreferences();
  const lastSettingsPage = useRef("bots");
  const settingsSearch = useRef(null);
  const [state, setState] = useState(empty);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(
    () => normalizePage(navigationStorage.getItem("boteam:page") || initialChat || "home"),
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
        if (lastPage === "channel-chats") navigationStorage.setItem("boteam:page", "channels");
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
        const opened = snapshot.chats.find(chat => chat.id === chatIdForPage(currentPage.current));
        if (initialChat && opened?.unread) {
          invoke("setChatUnread", { chatId: opened.id, unread: false }).catch(e => setError(errorText(e)));
        }
      }
      const savedChatIds = new Set(snapshot.chats.map(c => c.id));
      const draftKeys = new Set(Object.keys(draftPages.current));
      pruneComposerDrafts(savedChatIds, draftKeys);
      const channelChatIds = new Set((snapshot.channels || []).flatMap(channel => (channel.chats || []).map(chat => chat.id)));
      const channelPages = snapshot.chats.filter(chat => !chat.archived && channelChatIds.has(chat.id))
        .map(chat => channelChatPrefix + chat.id);
      const schedulePages = (snapshot.schedules || []).map(job => schedulePrefix + job.id);
      const accessible = new Set([...builtInPages, ...draftKeys, ...savedChatIds, ...channelPages, ...schedulePages]);
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
        let fallback = valid[index] || "home";
        if (currentPage.current.startsWith(channelChatPrefix)) fallback = "channels";
        if (currentPage.current.startsWith(schedulePrefix)) fallback = "schedules";
        if (valid[index] !== fallback) valid.splice(++index, 0, fallback);
        currentPage.current = fallback;
        setPage(fallback);
        navigationStorage.setItem("boteam:page", fallback);
      }
      if (valid.length !== previous.length || index !== historyPosition.current || valid[index] !== previous[index]) {
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
    const chatId = chatIdForPage(id);
    if (latest.current.chats.find(chat => chat.id === chatId)?.unread) {
      invoke("setChatUnread", { chatId, unread: false }).catch(e => setError(errorText(e)));
    }
  }, []);
  function move(direction) {
    const index = historyPosition.current + direction;
    if (index < 0 || index >= trail.current.length) return;
    historyPosition.current = index;
    setPosition(index);
    visit(trail.current[index]);
  }
  const select = useCallback(destination => {
    const id = normalizePage(destination);
    const index = historyPosition.current;
    if (trail.current[index] !== id) {
      trail.current = [...trail.current.slice(0, index + 1), id];
      historyPosition.current = trail.current.length - 1;
      setPosition(historyPosition.current);
    }
    visit(id);
  }, [visit]);
  useEffect(() => window.boteam?.onOpenChat?.(select), [select]);
  const openChannelChat = id => select(channelChatPrefix + id);
  const actions = useChatActions({ state, page: chatIdForPage(page), currentPage, dialog, setDialog, invoke, select, refresh, setError });
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
    if (currentPage.current === channelChatPrefix + id) openChannelChat(id);
    else select(id);
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
      if (e.defaultPrevented || e.repeat || !ready || !state.onboarded || dialog ||
          document.querySelector('[aria-modal="true"], dialog[open]')) return;
      const binding = shortcutFromEvent(e);
      if (!binding) return;
      if (binding === shortcuts.toggleSidebar && page !== "profile") setCollapsed(value => !value);
      else if (binding === shortcuts.newChat) newChat();
      else if (binding === shortcuts.searchChats) setDialog({ type: "search" });
      else if (binding === "Mod+F" && settingsPages.includes(page) && (/Mac/i.test(navigator.platform) ? e.metaKey : e.ctrlKey)) {
        setCollapsed(false);
        settingsSearch.current?.focus();
        settingsSearch.current?.select();
      }
      else return;
      e.preventDefault();
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [ready, state.onboarded, dialog, newChat, shortcuts, page]);
  const language = t("zh-CN", "en");
  useEffect(() => {
    if (ready && state.desktopNotificationsSupported)
      invoke("syncNotificationLanguage", { language }).catch(e => setError(errorText(e)));
  }, [ready, language, state.desktopNotificationsSupported]);
  const wizard = ready && !state.onboarded;
  const chat = state.chats.find((c) => c.id === chatIdForPage(page));
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
  const dialogPlatform = dialog?.type === "channelSetup" && platforms.find(p => p.id === dialog.id);
  const draftTitle = draft && !draft.legacyHome && (draft.name || (draft.kind === "group" ? t("新群聊", "New group chat") : panelMembers[0]?.name));
  const channelPage = page === "channels";
  const schedulePage = page === "schedules" || page.startsWith(schedulePrefix);
  const profilePage = !wizard && page === "profile";
  const section = profilePage || (!wizard && (settingsPages.includes(page) || chat?.archived)) ? "settings"
    : !wizard && (channelPage || page.startsWith(channelChatPrefix)) ? "channels" : !wizard && schedulePage ? "schedules" : "home";
  const settingsPage = chat?.archived ? "archived" : page;
  useEffect(() => {
    if (settingsPages.includes(settingsPage)) lastSettingsPage.current = settingsPage;
  }, [settingsPage]);
  const hasSecondary = !collapsed && !profilePage;
  const history = { back: position > 0, forward: position + 1 < trail.current.length, move };
  const pageTitle = wizard ? t("初始设置", "Initial setup") : chat?.name || draftTitle || ({
    bots: t("Bot 管理", "Bots"), accounts: t("账号管理", "CLI accounts"), archived: t("已归档会话", "Archived chats"),
    schedules: t("定时任务", "Schedules"), channels: t("频道", "Channels"),
  }[page]) || t("新对话", "New chat");
  const shellClasses = [
    "shell",
    settingsPages.includes(page) && !wizard ? "settings-shell" : "",
    profilePage ? "profile-shell" : "",
    !hasSecondary ? "sidebar-closed no-secondary-sidebar" : "",
    sidebarWidth != null ? "has-custom-rail" : "",
    panelWidth != null ? "has-custom-panel" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const shellStyle = {
    ...(sidebarWidth != null ? { "--custom-rail-width": `${sidebarWidth}px` } : {}),
    ...(panelWidth != null ? { "--custom-panel-width": `${panelWidth}px` } : {}),
    "--active-rail-width": hasSecondary ? "calc(var(--nav-width) + var(--rail-width))" : "var(--nav-width)",
  };
  const getLeftResizerBounds = () => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1260;
    const panelRect =
      workPage && panelVisible && !panel?.expanded && vw >= 900
        ? shellRef.current?.querySelector(".workspace-panel")?.getBoundingClientRect()
        : null;
    const reservedRight = panelRect ? Math.min(panelRect.width, Math.floor(vw * 0.48)) : 0;
    const navWidth = shellRef.current?.querySelector(".workspace-navigation")?.offsetWidth || 0;
    return {
      min: SIDEBAR_MIN_WIDTH,
      max: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(vw * 0.44), vw - navWidth - reservedRight - 300)),
    };
  };
  const getRightResizerBounds = () => {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1260;
    const sidebarRect = !collapsed ? shellRef.current?.querySelector(".sidebar")?.getBoundingClientRect() : null;
    const reservedLeft = (sidebarRect?.width || 0) + (shellRef.current?.querySelector(".workspace-navigation")?.offsetWidth || 0);
    return {
      min: PANEL_MIN_WIDTH,
      max: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, vw - reservedLeft - 300)),
    };
  };
  return (
    <div ref={shellRef} className={shellClasses} style={shellStyle}>
      <WorkspaceNavigation section={section} select={select} settingsPage={section === "settings" && !profilePage ? settingsPage : lastSettingsPage.current} disabled={wizard || !ready}/>
      {hasSecondary && (
        <>
          {section === "home" ? <Sidebar
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
            history={history}
          /> : <aside className={"sidebar " + (section === "settings" ? "context-sidebar" : section === "channels" ? "project-sidebar channel-sidebar" : "project-sidebar schedule-sidebar")} aria-label={t("侧栏", "Sidebar")}>
            <SidebarTitlebar collapse={() => setCollapsed(true)} history={history} disabled={!ready}/>
            {section === "channels" && <ChannelNavigation state={state} activeChatId={chat?.id} onOverview={() => select("channels")}
              onOpenChat={openChannelChat} onChatMenu={actions.showMenu}/>}
            {section === "schedules" && <ScheduleNavigation state={state} page={page} select={select}/>}
            {section === "settings" && <SettingsNavigation page={settingsPage} select={select} searchRef={settingsSearch}/>}
          </aside>}
          <PaneResizer
            side="left"
            label={t("调整侧边栏宽度", "Resize sidebar")}
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
        <header className={section === "channels" ? "topbar channel-topbar" : "topbar"}>
          {collapsed && !profilePage && (
            <IconButton
              icon={PanelLeftOpen}
              label={t("展开侧栏", "Expand sidebar")}
              onClick={() => setCollapsed(false)}
            />
          )}
          {!hasSecondary && <div className="window-history"><HistoryButtons history={history} disabled={wizard || !ready}/></div>}
          {section !== "schedules" && !profilePage && !settingsPages.includes(page) && <div className="window-title">{pageTitle}</div>}
          <div className="header-actions">
            {!wizard && (chat || draft)?.kind === "group" && (
              <button
                className="header-action"
                onClick={() => setDialog({ type: chat ? "group" : "draftGroup", id: (chat || draft).id })}
                aria-label={t("群聊设置", "Group chat settings")}
                title={t("群聊设置", "Group chat settings")}
              >
                <UsersRound size={15} />
                {(chat || draft).members.length} {t("位成员", "members")}
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
              label={t("关闭提示", "Dismiss")}
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
                    {t("重试", "Try again")}
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
        ) : profilePage ? (
          <ProfilePage state={state} invoke={invoke}/>
        ) : channelPage ? (
          <Channels state={state} invoke={invoke} refreshSnapshot={refresh} open={setDialog}/>
        ) : schedulePage ? (
          <SchedulesPage state={state} page={page} invoke={invoke} select={select} refresh={refresh} open={setDialog}/>
        ) : ["general", "appearance", "notifications", "shortcuts"].includes(page) ? (
          <AppSettings key={page} page={page} state={state} invoke={invoke} refresh={refresh}/>
        ) : ["usage", "integrations-channels", "extensions", "mcp"].includes(page) ? (
          <IntegrationSettings key={page} page={page} state={state} invoke={invoke} refresh={refresh} open={setDialog} select={select}/>
        ) : ["storage", "backup"].includes(page) ? (
          <DataSettings key={page} page={page} state={state} invoke={invoke} refresh={refresh}/>
        ) : ["permissions", "directories", "worktrees"].includes(page) ? (
          <CodingSettings key={page} page={page} state={state} invoke={invoke} refresh={refresh} open={setDialog} select={select}/>
        ) : page === "archived" ? (
          <ArchivedChats state={state} select={select} action={actions.act}/>
        ) : page === "local-accounts" ? (
          <LocalAccountSettings open={setDialog}/>
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
          label={t("调整右侧面板宽度", "Resize workspace panel")}
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
      {dialog?.type === "directory" && <Modal title={t("选择工作目录", "Select working directory")} onClose={close}>
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
        <Modal title={t("搜索对话", "Search chats")} onClose={close}>
          <ChatSearch state={state} select={select} />
        </Modal>
      )}
      {dialogPlatform && <ChannelSetupDialog key={dialogPlatform.id} platform={dialogPlatform}
        config={state.channels?.find(channel => channel.id === dialogPlatform.id)} state={state}
        invoke={invoke} refreshSnapshot={refresh} onClose={close} onManageBots={() => select("bots")}/>}
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
          title={t("导入本机账号", "Import local accounts")}
          subtitle={t("选择原生工具配置，导入已识别的订阅账号。", "Choose a local CLI configuration to import a subscription account.")}
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
        <Modal title={dialogBot ? t("编辑 Bot", "Edit bot") : t("创建 Bot", "Create bot")} onClose={close}>
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
                {t("先连接一个订阅账号，再为 Bot 选择身份。", "Connect a CLI account to create a bot.")}
              </div>
              <div className="form-actions">
                <Button onClick={close}>{t("取消", "Cancel")}</Button>
                <Button
                  variant="primary"
                  onClick={() => setDialog({ type: "import", returnTo: dialog })}
                >
                  {t("导入账号", "Import account")}
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
              : dialog.type === "draftGroup" && draft?.id === dialog.id ? { ...draft, name: draft.name || t("新群聊", "New group chat") } : undefined
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
  const t = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t(`移除 ${bot.name}？`, `Remove ${bot.name}?`)}
      subtitle={t("Bot 将被归档并停止接收新任务，已有聊天记录会保留。", "The bot will be archived and stop receiving tasks. Existing chats will be kept.")}
      onClose={onClose}
    >
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button onClick={onClose}>{t("取消", "Cancel")}</Button>
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
          {t("确认移除", "Remove")}
        </Button>
      </div>
    </Modal>
  );
}
