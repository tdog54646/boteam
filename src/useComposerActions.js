import { useCallback } from "react";
import { useNativeCatalog } from "./useNativeCatalog";

export function useComposerActions({ state, chat, draft, bot, projectCwd, draftSettings, invoke }) {
  const chatId = chat?.id;
  const botId = bot?.id;
  const account = state.accounts.find(a => a.id === bot?.accountId);
  const thread = state.nativeThreads?.find(t => t.chatId === chatId && t.botId === botId);
  const settings = draftSettings || state.composerSettings?.find(s => s.chatId === chatId && s.botId === botId);
  const model = settings?.model ?? bot?.model;
  const effort = settings?.effort ?? bot?.effort;
  const projectId = draft?.projectId ?? chat?.projectId;
  const configuredDefault = state.projectPermissionDefaults?.find(item => item.projectId === projectId && item.provider === account?.provider)?.permission
    ?? state.botPermissionDefaults?.find(item => item.botId === botId)?.permission;
  const inheritedPermission = configuredDefault ?? "default";
  const permission = settings?.permission ?? inheritedPermission;
  const planMode = Boolean(settings?.planMode || permission === "plan");
  const id = JSON.stringify([
    chatId || draft?.id, botId, chat?.projectId || draft?.projectId, projectCwd,
    permission, model || account?.model, effort, planMode,
  ]);
  const binding = JSON.stringify([
    bot?.cwd, account?.id, account?.provider, account?.identity, account?.status,
    account?.cwd, account?.bin, account?.source, account?.plan, account?.bindingRevision,
    thread?.threadId, thread?.cwd,
  ]);
  const query = useCallback(force => invoke("composerActions", {
    botId,
    ...(chatId && { chatId }),
    ...(draft && { draft }),
    ...(draft && draftSettings && { settings: draftSettings }),
    ...(force && { refresh: true }),
  }), [invoke, botId, chatId, draft, draftSettings]);
  const fallbackKey = JSON.stringify([
    binding, chatId || draft?.id, botId, chat?.projectId || draft?.projectId, projectCwd,
  ]);
  const enabled = Boolean(botId && account?.status === "ready");
  const result = useNativeCatalog({ id, binding, fallbackKey, enabled, query, refreshOnEntry: true });
  return {
    ...result,
    hasPermissionDefault: configuredDefault != null, inheritedPermission, permission, planMode,
    scope: JSON.stringify([id, binding]),
    error: !enabled && botId ? account?.reason || "请先核实此账号的原生登录。" : result.error,
  };
}
