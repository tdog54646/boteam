import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Channels } from "./Channels";
import { useLanguage } from "./preferences";
import { accountLabel, Button, errorText, Notice, providerName, ProviderIcon, Select, Status } from "./ui";
import { useNativeCatalog } from "./useNativeCatalog";

function SettingsPage({ title, detail, children }) {
  return <div className="page-scroll"><article className="settings-page">
    <header className="settings-heading"><h1>{title}</h1><p>{detail}</p></header>
    {children}
  </article></div>;
}

function NativeCatalog({ page, bot, account, folder, invoke }) {
  const t = useLanguage();
  const mcp = page === "mcp";
  const folderPath = folder?.path;
  const projectId = folder?.projectId;
  const explicitFolder = folder?.primary ? undefined : folderPath;
  const binding = JSON.stringify([page, bot.id, bot.cwd, bot.model, bot.effort, account?.id,
    account?.status, account?.bindingRevision, account?.bin, account?.source, account?.cwd,
    account?.identity, account?.plan, account?.model, projectId, folderPath]);
  const supported = !mcp || account?.provider === "codex";
  const enabled = supported && account?.status === "ready";
  const query = useCallback(force => {
    const scope = { botId: bot.id, ...(projectId && { catalogProject: { projectId, folder: explicitFolder } }) };
    return mcp ? invoke("slashInfo", { ...scope, name: "mcp" }) : invoke("composerActions", { ...scope, refresh: force });
  }, [invoke, mcp, bot.id, projectId, explicitFolder]);
  const { data, pending, error, retry } = useNativeCatalog({ id: binding, binding, enabled, query, refreshOnEntry: true });
  const items = data?.extensions || [];
  return <section>
    <div className="settings-section-heading">
      <h2>{mcp ? t("服务器状态", "Server status") : t("可用插件与技能", "Available plugins and skills")}</h2>
      {enabled && <Button icon={RefreshCw} busy={pending} onClick={retry}>{t("刷新", "Refresh")}</Button>}
    </div>
    <div className="settings-group" aria-busy={pending}>
      {!supported ? <p className="settings-empty">{t("此原生工具未提供 MCP 服务器状态查询。", "This CLI does not expose MCP server status.")}</p>
        : !enabled ? <p className="settings-empty">{account?.reason || t("请先在账号管理中完成原生登录。", "Sign in to this CLI in account settings first.")}</p>
        : <>
          {error && <Notice>{error}</Notice>}
          {pending && !data && <p className="settings-empty" role="status">{t("正在读取原生配置…", "Reading CLI configuration…")}</p>}
          {data?.note && <p className="settings-empty" role="status">{data.note}</p>}
          {mcp && data?.lines?.map((line, index) =>
            <div className="settings-row" key={index}><div className="row-copy">{line}</div></div>)}
          {!mcp && items.map(item => <div className="settings-row" key={item.id}>
            <div className="row-copy"><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</div>
            <small>{item.kind === "skill" ? t("技能", "Skill") : item.kind === "app" ? t("应用", "App") : t("插件", "Plugin")}</small>
          </div>)}
          {data && !error && !pending && (mcp ? !data.lines?.length : !items.length) &&
            <p className="settings-empty">{mcp ? t("此目录没有 MCP 服务器。", "No MCP servers in this directory.")
              : t("原生工具未返回可用的插件或技能。", "The CLI returned no plugins or skills.")}</p>}
        </>}
    </div>
  </section>;
}

function CatalogPage({ page, state, invoke, select }) {
  const t = useLanguage();
  const [botId, setBotId] = useState("");
  const [folderKey, setFolderKey] = useState("");
  const bots = state.bots.filter(bot => !bot.archived);
  const bot = bots.find(item => item.id === botId) || bots[0];
  const account = state.accounts.find(item => item.id === bot?.accountId);
  const folders = state.projects.flatMap(p => [
    { key: p.id, projectId: p.id, path: p.folders[0], primary: true,
      label: p.folders.length > 1 ? p.name + " · " + t("默认目录", "Default directory") : p.name },
    ...(p.folders.length > 1 ? p.folders.map(path => ({
      key: JSON.stringify([p.id, path]), projectId: p.id, path, label: p.name + " · " + path,
    })) : []),
  ]);
  const folder = folders.find(item => item.key === folderKey);
  const mcp = page === "mcp";
  return <SettingsPage title={mcp ? t("MCP 服务器", "MCP servers") : t("插件与技能", "Plugins and skills")}
    detail={mcp ? t("查看所选 Bot 和工作目录的 MCP 连接状态。", "Check MCP connections for a bot and working directory.")
      : t("查看所选 Bot 在工作目录中可用的插件、应用和技能。", "See the plugins, apps and skills available to a bot in its working directory.")}>
    {!bot ? <div className="settings-row"><div className="row-copy">{t("创建 Bot 后可查看原生配置。", "Create a bot to view its CLI configuration.")}</div>
      <Button onClick={() => select("bots")}>{t("Bot 管理", "Manage bots")}</Button></div> : <>
      <section><h2>{t("查询范围", "Scope")}</h2><div className="settings-group">
        <div className="settings-row"><label className="row-copy" htmlFor="catalog-bot"><strong>Bot</strong>
          <small>{providerName(account?.provider)} · {accountLabel(account)}</small></label>
          <Select id="catalog-bot" value={bot.id} onChange={event => setBotId(event.target.value)}>
            {bots.map(item => <option key={item.id} value={item.id}>{item.name} · {accountLabel(state.accounts.find(a => a.id === item.accountId))}</option>)}
          </Select>
        </div>
        <div className="settings-row"><label className="row-copy" htmlFor="catalog-project"><strong>{t("工作目录", "Working directory")}</strong>
          <small>{folder?.path || bot.cwd || account?.cwd || t("BoTeam 默认工作目录", "BoTeam default directory")}</small></label>
          <Select id="catalog-project" value={folder?.key || ""} onChange={event => setFolderKey(event.target.value)}>
            <option value="">{t("Bot 默认目录", "Bot default directory")}</option>
            {folders.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </Select>
        </div>
      </div></section>
      <NativeCatalog page={page} bot={bot} account={account} folder={folder} invoke={invoke}/>
    </>}
  </SettingsPage>;
}

function AccountUsage({ account, bots, quotas, invoke, open, refresh }) {
  const t = useLanguage();
  const [model, setModel] = useState("");
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, Date.now());
  const liveQuotas = quotas.map(q => ({
    ...q,
    windows: q.windows.filter(w => Number.isFinite(w?.remainingPercent) && w.remainingPercent >= 0 &&
      w.remainingPercent <= 100 && (!w.resetsAt || w.resetsAt > now)),
  })).filter(q => q.windows.length);
  const nextReset = Math.min(...liveQuotas.flatMap(q => q.windows.map(w => w.resetsAt ?? Infinity)));
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(2147483647, Math.max(0, nextReset - Date.now()) + 1));
    return () => clearTimeout(timer);
  }, [nextReset, clock]);
  const models = [...new Set([...bots, ...quotas].map(row => row.model).filter(Boolean))];
  const selectedModel = models.includes(model) ? model : "";
  const dateTime = value => new Date(value).toLocaleString(t("zh-CN", "en"), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  async function read() {
    setReading(true);
    setError("");
    setMessage("");
    try {
      const result = await invoke("settingsAccountQuota", { accountId: account.id, model: selectedModel });
      if (!result) setMessage(t("原生工具未返回此模型的额度。", "The CLI did not return quota for this model."));
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setReading(false); }
  }
  return <section aria-label={accountLabel(account)}>
    <div className="settings-section-heading"><h2>{accountLabel(account)}</h2>
      <Button onClick={() => open({ type: "account", id: account.id })}>{t("管理账号", "Manage account")}</Button>
    </div>
    <div className="settings-group">
      <div className="settings-row"><ProviderIcon provider={account.provider}/><div className="row-copy">
        <strong>{[providerName(account.provider), account.plan].filter(Boolean).join(" · ")}</strong>
        <small>{account.note && account.email ? account.email + " · " : ""}{bots.length ? bots.map(bot => bot.name).join("、") : t("尚未绑定 Bot", "No linked bots")}</small>
      </div><Status status={account.status}/></div>
      {liveQuotas.map(q => <div className="settings-row" key={q.model}>
        <div className="row-copy quota-windows"><strong>{q.model || t("账号共享额度", "Shared account quota")}</strong>
          {q.windows.map(w => {
            const period = w.minutes === 10080 ? t("每周", "Weekly") : t("5 小时", "5 hours");
            return <div key={w.minutes} className="quota-window">
              <small>{period}{w.group && " · " + w.group}{w.shared && " · " + t("账号共享", "Shared across account")}
                {w.resetsAt && " · " + t("重置于 ", "Resets at ") + dateTime(w.resetsAt)}
              </small>
              <div className="quota-remaining">
                <progress max={100} value={w.remainingPercent} data-low={w.remainingPercent <= 10 || undefined}
                  aria-label={[q.model, period, t("剩余额度", "Remaining quota")].filter(Boolean).join(" · ")}/>
                <small aria-hidden="true">{t("剩余 ", "Remaining ")}{w.remainingPercent}%</small>
              </div>
            </div>;
          })}
          {q.updatedAt && <small>{t("更新于 ", "Updated ")}{dateTime(q.updatedAt)}</small>}
        </div>
      </div>)}
      {!liveQuotas.length && <div className="settings-row"><div className="row-copy">
        <strong>{account.quota ? t("上次账号检测", "Last account check") : t("剩余额度", "Remaining quota")}</strong>
        <small>{account.quota || t("暂无额度数据", "No quota data yet")}</small>
      </div></div>}
      {account.status === "ready" && <div className="settings-row">
        <label className="row-copy" htmlFor={"quota-" + account.id}><strong>{t("查询额度", "Check quota")}</strong></label>
        {models.length > 0 && <Select id={"quota-" + account.id} value={selectedModel} disabled={reading}
          onChange={e => { setModel(e.target.value); setError(""); setMessage(""); }}>
          <option value="">{t("原生默认模型", "CLI default model")}</option>
          {models.map(id => <option value={id} key={id}>{id}</option>)}
        </Select>}
        <Button icon={RefreshCw} busy={reading} onClick={read}>{t("刷新额度", "Refresh quota")}</Button>
      </div>}
    </div>
    {message && <p role="status" className="settings-empty">{message}</p>}
    <Notice>{error}</Notice>
  </section>;
}

export function IntegrationSettings({ page, state, invoke, open, select, refresh }) {
  const t = useLanguage();
  if (page === "integrations-channels")
    return <Channels inSettings open={open} state={state} invoke={invoke} refreshSnapshot={refresh}/>;
  if (page !== "usage") return <CatalogPage page={page} state={state} invoke={invoke} select={select}/>;
  return <SettingsPage title={t("使用情况", "Usage")} detail={t("按订阅账号查看套餐、模型额度和重置时间。", "View plans, model quotas and reset times by subscription account.")}>
    {state.accounts.map(account => <AccountUsage key={account.id + "/" + account.bindingRevision} account={account}
      bots={state.bots.filter(b => !b.archived && b.accountId === account.id)}
      quotas={(state.quotas || []).filter(q => q.accountId === account.id)}
      invoke={invoke} open={open} refresh={refresh}/>)}
    {!state.accounts.length && <div className="settings-row"><div className="row-copy">{t("尚未添加订阅账号", "No subscription accounts yet")}</div>
      <Button onClick={() => select("accounts")}>{t("账号管理", "Manage accounts")}</Button></div>}
  </SettingsPage>;
}
