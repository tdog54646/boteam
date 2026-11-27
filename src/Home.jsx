import React, { useState } from "react";
import { BotMessageSquare, ChevronDown, WalletCards, Plus, UsersRound } from "lucide-react";
import { Button, accountLabel, ProviderIcon } from "./ui";
import { useLanguage } from "./preferences";
import { Composer } from "./Composer";

export function Home({ state, invoke, open, draft, members, setSelection, firstProject,
  onSent, onNewDraft, sourceControl, onDraftFiles }) {
  const t = useLanguage();
  const project = state.projects.find(p => p.id === firstProject?.projectId);
  const bots = state.bots.filter((b) => !b.archived);
  const [busy, setBusy] = useState(false);
  const bot = members[0];
  const group = draft?.kind === "group";
  const account = state.accounts.find((a) => a.id === bot?.accountId);
  let heading = state.accounts.length ? t("创建你的第一个 Bot", "Create your first bot") : t("连接你的 AI 账号", "Connect your AI account");
  if (group) heading = draft.name || t("新群聊", "New group chat");
  else if (draft) {
    if (!bot) heading = t("此 Bot 已归档", "This bot is archived");
    else if (project) heading = t(`你想让我们在 ${project.name} 中构建什么？`, `What should we build in ${project.name}?`);
    else heading = t("有什么需要帮忙？", "What can we help you with?");
  }
  return (
    <div className={draft ? "home home-draft" : "home"}>
      <div className="home-stack">
        <div className="home-heading">
          {account && !group
            ? <ProviderIcon provider={account.provider} size="large" />
            : <BotMessageSquare className="home-mark" size={47} strokeWidth={1.35} aria-hidden="true"/>}
          <h1>{heading}</h1>
        </div>
        {draft ? (
          <Composer
            key={draft.legacyHome ? "home:" + draft.members[0] : draft.id}
            state={state}
            members={members}
            draft={draft}
            firstProject={firstProject}
            invoke={invoke}
            onSent={onSent}
            onNewDraft={onNewDraft}
            sourceControl={sourceControl}
            onDraftFiles={onDraftFiles}
            onBusyChange={setBusy}
          />
        ) : (
          <>
            <p className="home-description">
              {state.accounts.length
                ? t("选择订阅账号并为 Bot 命名，即可开始聊天。", "Choose a CLI account and name your bot to start chatting.")
                : t("导入本机已登录的订阅账号，创建可以私聊和加入群聊的 Bot。", "Import a local CLI account to create a bot for direct or group chats.")}
            </p>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() =>
                open({ type: state.accounts.length ? "bot" : "import" })
              }
            >
              {state.accounts.length ? t("创建 Bot", "Create bot") : t("导入本机账号", "Import local account")}
            </Button>
          </>
        )}
        {group && <div className="empty-member-strip">{members.map(member =>
          <span key={member.id}><ProviderIcon size="small"
            provider={state.accounts.find(a => a.id === member.accountId)?.provider} />{member.name}</span>)}</div>}
        {bot && !group && (
          <div className="home-context">
            {setSelection ? <label className="bot-picker" title={t("选择接收 Bot", "Select recipient bot")}>
              <ProviderIcon provider={account?.provider} size="small" />
              <span>{bot.name}</span>
              <ChevronDown size={12} />
              <select
                aria-label={t("选择接收 Bot", "Select recipient bot")}
                value={bot.id}
                disabled={busy}
                onChange={(e) => setSelection(e.target.value)}
              >
                {bots.map((b) => (
                  <option value={b.id} key={b.id}>
                    {b.name} ·{" "}
                    {accountLabel(
                      state.accounts.find((a) => a.id === b.accountId),
                    )}
                  </option>
                ))}
              </select>
            </label> : <span className="home-account"><ProviderIcon provider={account?.provider} size="small" />{bot.name}</span>}
            <span className="home-account">
              <WalletCards size={14} />
              {accountLabel(account)}
            </span>
            <button onClick={() => open({ type: "chat", kind: "group", projectId: firstProject?.projectId })}>
              <UsersRound size={14} />
              {t("新建群聊", "New group chat")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
