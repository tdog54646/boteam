import React, { useEffect, useState } from "react";
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
  const [catalog, setCatalog] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = accounts.find((a) => a.id === accountId);
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    invoke("botOptions", { accountId })
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((err) => {
        if (active) setCatalog({ reason: errorText(err) });
      });
    return () => {
      active = false;
    };
  }, [invoke, accountId, attempt]);

  const loading = Boolean(accountId && !catalog);
  function changeAccount(id) {
    setCatalog(null);
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
      <Field label="Bot 名称">
        <input
          data-autofocus
          autoFocus={onboarding}
          value={name}
          required
          placeholder="例如，代码助手"
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
      </Field>
      <Field label="绑定账号" hint="每个 Bot 固定使用一个订阅账号。">
        <Select
          value={accountId}
          onChange={(e) => changeAccount(e.target.value)}
          disabled={!!initial}
          required
        >
          <option value="" disabled>
            选择订阅账号
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
            ? "请在「账号管理」中为此账号重新授权，再给 Bot 派发任务。"
            : account.reason || "派发任务前需要完成账号验证。"}
        </div>
      )}
      <div className="field bot-native-options" role="group" aria-label="模型与思考强度">
        <span className="field-label">模型与思考强度</span>
        <NativeModelPicker
          key={accountId}
          provider={account?.provider}
          catalog={catalog}
          model={model}
          effort={effort}
          loading={loading}
          busy={busy || pending}
          retry={() => { setCatalog(null); setAttempt((value) => value + 1); }}
          onChange={(patch) => {
            if (patch.model !== undefined) setModel(patch.model);
            if (patch.effort !== undefined) setEffort(patch.effort);
          }}
          resetLabel="恢复原生默认设置"
          resetDisabled={!model && !effort}
          onReset={() => { setModel(""); setEffort(""); }}
        />
      </div>
      <div className="field">
        <label htmlFor="bot-cwd" className="field-label">
          工作目录 <span>可选</span>
        </label>
        <div className="input-action">
          <input
            id="bot-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="使用默认工作目录"
          />
          <IconButton
            icon={FolderOpen}
            label="选择工作目录"
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
            移除 Bot
          </button>
        ) : (
          <button
            type="button"
            className="text-btn subtle"
            onClick={onCancel}
            disabled={busy || pending}
          >
            {onboarding ? "稍后创建" : "取消"}
          </button>
        )}
        <Button
          variant="primary"
          busy={busy}
          disabled={!accountId || !name.trim() || pending}
          type="submit"
        >
          {onboarding ? "创建并开始聊天" : initial ? "保存修改" : "创建 Bot"}
        </Button>
      </div>
    </form>
  );
}
export function BotList({ accounts, bots, open, startDirect }) {
  const active = bots.filter((b) => !b.archived);
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <h1>Bot 管理</h1>
        <p>为 Bot 选择订阅账号、默认模型和工作目录。</p>
      </header>
      <section aria-label="我的 Bot">
        <div className="settings-section-heading">
          <h2>我的 Bot</h2>
          <Button icon={Plus} onClick={() => open({ type: "bot" })}>
            创建 Bot
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
                    label={`与 ${b.name} 开始私聊`}
                    onClick={() => startDirect(b.id)}
                  />
                  <IconButton
                    icon={MoreHorizontal}
                    label={`管理 ${b.name}`}
                    onClick={() => open({ type: "bot", id: b.id })}
                  />
                </div>
              );
            })
          ) : (
            <p className="settings-empty">尚未创建 Bot</p>
          )}
        </div>
      </section>
    </div>
  );
}
export function ChatDialog({
  kind,
  chat,
  bots,
  accounts,
  projects = [],
  initialProjectId,
  defaultBotId,
  invoke,
  onDone,
  onClose,
  newBot,
}) {
  const [type, setType] = useState(chat?.kind || kind || "direct");
  const [name, setName] = useState(chat?.name || "");
  const [originalName] = useState(chat?.name);
  const [projectId, setProjectId] = useState(initialProjectId || "");
  const project = projects.find(p => p.id === projectId);
  const [selected, setSelected] = useState(
    chat?.members?.filter((id) =>
      bots.some((b) => b.id === id && !b.archived),
    ) || (kind !== "group" && defaultBotId ? [defaultBotId] : []),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = bots.filter((b) => !b.archived);
  const group = type === "group";
  async function save(e) {
    e.preventDefault();
    if (busy || !selected.length || (chat && !name.trim()) || (projectId && !project)) return;
    setBusy(true);
    setError("");
    try {
      const data = { members: selected, ...(chat && name.trim() !== originalName && { name: name.trim() }) };
      const id = chat
        ? await invoke("editGroup", { id: chat.id, ...data })
        : await invoke("createChat", { kind: type, ...data, ...(project && { projectId }) });
      await onDone(chat?.id || id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={chat ? "群聊设置" : "新建对话"} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={save}>
        {!chat && (
          <div className="segmented" role="group" aria-label="对话类型">
            {[
              ["direct", "私聊"],
              ["group", "群聊"],
            ].map(([v, label]) => (
              <button
                type="button"
                key={v}
                data-autofocus={type === v || undefined}
                aria-pressed={type === v}
                onClick={() => {
                  setType(v);
                  setSelected((s) => (v === "direct" ? s.slice(0, 1) : s));
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {!chat && (projects.length > 0 || projectId) && <Field label="项目">
          <Select value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">不加入项目</option>
            {projectId && !project && <option value={projectId} disabled>项目已移除</option>}
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>}
        {chat && (
          <Field label="群聊名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </Field>
        )}
        <div className="field">
          <h3 className="field-label">{group ? "选择群成员" : "选择 Bot"}</h3>
          {active.length ? (
            <MemberList
              bots={active}
              accounts={accounts}
              selected={selected}
              setSelected={setSelected}
              multi={group}
            />
          ) : (
            <div className="settings-group">
              <div className="settings-row">
                <p>先创建一个 Bot，即可开始对话。</p>
                <Button icon={Plus} onClick={() => newBot({ kind: type, projectId })}>
                  创建 Bot
                </Button>
              </div>
            </div>
          )}
        </div>
        <Notice>{error}</Notice>
        <div className="form-actions">
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!selected.length || (chat && !name.trim()) || (projectId && !project)}
            busy={busy}
          >
            {chat ? "保存修改" : group ? "创建群聊" : "开始私聊"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
