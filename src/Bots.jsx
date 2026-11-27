import { useLanguage } from "./preferences";
import React, { useState } from "react";
import { FolderOpen, MessageSquare, MoreHorizontal, Plus } from "lucide-react";
import {
  accountLabel,
  Button,
  errorText,
  Field,
  IconButton,
  identityLabel,
  MemberList,
  Modal,
  needsAntigravityBinding,
  Notice,
  ProviderIcon,
  providerName,
  Select,
  Status,
} from "./ui";
import { NativeModelPicker } from "./NativeModelPicker";
import { useModelCatalog } from "./useModelCatalog";
import "./settings.css";

export function BotForm({
  accounts,
  initial,
  defaultAccountId,
  invoke,
  onDone,
  onCancel,
  onboarding = false,
  pending = false,
  onRemove,
}) {
  const tr = useLanguage();
  const [accountId, setAccountId] = useState(
    initial?.accountId ||
      defaultAccountId ||
      accounts.find((a) => a.status === "ready")?.id ||
      accounts[0]?.id ||
      "",
  );
  const [name, setName] = useState(initial?.name || "");
  const [cwd, setCwd] = useState(initial?.cwd || "");
  const [model, setModel] = useState(initial?.model || "");
  const [effort, setEffort] = useState(initial?.effort || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = accounts.find((a) => a.id === accountId);
  const { catalog, loading, refresh } = useModelCatalog(account, invoke);
  function changeAccount(id) {
    setAccountId(id);
    setModel("");
    setEffort("");
  }
  async function save(e) {
    e.preventDefault();
    if (!name.trim() || !accountId) return;
    setBusy(true);
    setError("");
    try {
      const data = { name: name.trim(), cwd: cwd.trim(), model, effort };
      const id = initial
        ? await invoke("editBot", { id: initial.id, ...data })
        : await invoke("createBot", { accountId, ...data });
      await onDone(initial?.id || id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="bot-form">
      <Field label={tr("Bot 名称", "Bot name")}>
        <input
          data-autofocus
          autoFocus={onboarding}
          value={name}
          required
          placeholder={tr("例如，代码助手", "For example, coding assistant")}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
      </Field>
      <Field label={tr("绑定账号", "Linked account")} hint={tr("每个 Bot 固定使用一个订阅账号。", "Each bot uses one subscription account.")}>
        <Select
          value={accountId}
          onChange={(e) => changeAccount(e.target.value)}
          disabled={!!initial}
          required
        >
          <option value="" disabled>
            {tr("选择订阅账号", "Choose a subscription account")}
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {providerName(a.provider)} · {accountLabel(a)}
              {a.note ? ` · ${identityLabel(a)}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      {account && account.status !== "ready" && (
        <div className="info-line">
          <Status status={account.status} />
          {needsAntigravityBinding(account)
            ? tr("请在「账号管理」中为此账号重新授权，再给 Bot 派发任务。", "Reauthorize this account in Settings before assigning work to the bot.")
            : account.reason || tr("派发任务前需要完成账号验证。", "Verify this account before assigning work.")}
        </div>
      )}
      <div className="field bot-native-options" role="group" aria-label={tr("模型与思考强度", "Model and reasoning effort")}>
        <span className="field-label">{tr("模型与思考强度", "Model and reasoning effort")}</span>
        <NativeModelPicker
          key={accountId}
          provider={account?.provider}
          catalog={catalog}
          model={model}
          effort={effort}
          loading={loading}
          busy={busy || pending}
          refresh={refresh}
          onChange={(patch) => {
            if (patch.model !== undefined) setModel(patch.model);
            if (patch.effort !== undefined) setEffort(patch.effort);
          }}
          resetLabel={tr("恢复原生默认设置", "Restore CLI defaults")}
          resetDisabled={!model && !effort}
          onReset={() => { setModel(""); setEffort(""); }}
        />
      </div>
      <div className="field">
        <label htmlFor="bot-cwd" className="field-label">
          {tr("工作目录", "Working directory")} <span>{tr("可选", "Optional")}</span>
        </label>
        <div className="input-action">
          <input
            id="bot-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={tr("使用默认工作目录", "Use default working directory")}
          />
          <IconButton
            icon={FolderOpen}
            label={tr("选择工作目录", "Choose working directory")}
            onClick={async () => {
              try {
                const path = await invoke("pickDirectory");
                if (path) setCwd(path);
              } catch (err) {
                setError(errorText(err));
              }
            }}
          />
        </div>
      </div>
      <Notice>{error}</Notice>
      <div
        className={
          onboarding
            ? "setup-footer"
            : `form-actions ${onRemove ? "spread" : ""}`
        }
      >
        {onRemove ? (
          <button
            type="button"
            className="text-btn danger-text"
            onClick={onRemove}
            disabled={busy}
          >
            {tr("移除 Bot", "Remove bot")}
          </button>
        ) : (
          <button
            type="button"
            className="text-btn subtle"
            onClick={onCancel}
            disabled={busy || pending}
          >
            {onboarding ? tr("稍后创建", "Create later") : tr("取消", "Cancel")}
          </button>
        )}
        <Button
          variant="primary"
          busy={busy}
          disabled={!accountId || !name.trim() || pending}
          type="submit"
        >
          {onboarding ? tr("创建并开始聊天", "Create and start chatting") : initial ? tr("保存修改", "Save changes") : tr("创建 Bot", "Create bot")}
        </Button>
      </div>
    </form>
  );
}
export function BotList({ accounts, bots, open, startDirect }) {
  const tr = useLanguage();
  const active = bots.filter((b) => !b.archived);
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <h1>{tr("Bot 管理", "Bots")}</h1>
        <p>{tr("为 Bot 选择订阅账号、默认模型和工作目录。", "Choose your bots’ subscription accounts, default models and working directories.")}</p>
      </header>
      <section aria-label={tr("我的 Bot", "My bots")}>
        <div className="settings-section-heading">
          <h2>{tr("我的 Bot", "My bots")}</h2>
          <Button icon={Plus} onClick={() => open({ type: "bot" })}>
            {tr("创建 Bot", "Create bot")}
          </Button>
        </div>
        <div className="settings-group">
          {active.length ? (
            active.map((b) => {
              const a = accounts.find((x) => x.id === b.accountId);
              return (
                <div className="settings-row" key={b.id}>
                  <ProviderIcon provider={a?.provider} />
                  <div className="row-copy">
                    <strong>{b.name}</strong>
                    <small>
                      {providerName(a?.provider)} · {accountLabel(a)}
                      {a?.note ? ` · ${identityLabel(a)}` : ""}
                      {b.model ? ` · ${b.model}` : ""}
                      {b.effort ? ` · ${b.effort}` : ""}
                    </small>
                  </div>
                  <IconButton
                    icon={MessageSquare}
                    label={tr(`与 ${b.name} 开始私聊`, `Start a chat with ${b.name}`)}
                    onClick={() => startDirect(b.id)}
                  />
                  <IconButton
                    icon={MoreHorizontal}
                    label={tr(`管理 ${b.name}`, `Manage ${b.name}`)}
                    onClick={() => open({ type: "bot", id: b.id })}
                  />
                </div>
              );
            })
          ) : (
            <p className="settings-empty">{tr("尚未创建 Bot", "No bots yet")}</p>
          )}
        </div>
      </section>
    </div>
  );
}
export function ChatDialog({
  chat,
  bots,
  accounts,
  projects = [],
  initialProjectId,
  invoke,
  onNewDraft,
  onEditDraft,
  onDone,
  onClose,
  newBot,
}) {
  const tr = useLanguage();
  const [name, setName] = useState(chat?.name || "");
  const [originalName] = useState(chat?.name);
  const project = projects.find((p) => p.id === initialProjectId);
  const [selected, setSelected] = useState(
    chat?.members?.filter((id) =>
      bots.some((b) => b.id === id && !b.archived),
    ) || [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = bots.filter((b) => !b.archived);
  async function save(e) {
    e.preventDefault();
    if (busy || !selected.length || (chat && !name.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (chat) {
        const changes = { members: selected, ...(name.trim() !== originalName && { name: name.trim() }) };
        if (onEditDraft) onEditDraft(changes);
        else {
          await invoke("editGroup", { id: chat.id, ...changes });
          await onDone(chat.id);
        }
      } else {
        onNewDraft({ kind: "group", members: selected, ...(project && { projectId: project.id }) });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={chat ? tr("群聊设置", "Group chat settings") : tr("新建群聊", "New group chat")} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={save}>
        {chat && (
          <Field label={tr("群聊名称", "Group name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </Field>
        )}
        <div className="field">
          <h3 className="field-label">{tr("选择群成员", "Choose members")}</h3>
          {active.length ? (
            <MemberList
              bots={active}
              accounts={accounts}
              selected={selected}
              setSelected={setSelected}
              multi
              autoFocusFirst={!chat}
            />
          ) : (
            <div className="settings-group">
              <div className="settings-row">
                <p>{tr("先创建一个 Bot，即可开始对话。", "Create a bot to start chatting.")}</p>
                <Button icon={Plus} onClick={() => newBot({ kind: "group", projectId: project?.id })}>
                  {tr("创建 Bot", "Create bot")}
                </Button>
              </div>
            </div>
          )}
        </div>
        <Notice>{error}</Notice>
        <div className="form-actions">
          <Button disabled={busy} onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!selected.length || (chat && !name.trim())}
            busy={busy}
          >
            {chat ? tr("保存修改", "Save changes") : tr("创建群聊", "Create group chat")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
