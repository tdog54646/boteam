import React, { useEffect, useState } from "react";
import { usePreferences } from "./preferences";
import { errorText } from "./ui";

function formatSize(bytes, language) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const index = bytes ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1000))) : 0;
  return new Intl.NumberFormat(language, { style: "unit", unit: units[index], unitDisplay: "short", maximumFractionDigits: 1 })
    .format(bytes / (1000 ** index));
}

export function DataSettings({ page, invoke }) {
  const { language, t } = usePreferences();
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    setNotice("");
    if (page === "storage") {
      setBusy("data:storage");
      setUsage(null);
      invoke("data:storage").then(result => { if (live) setUsage(result); })
        .catch(e => { if (live) setError(errorText(e)); })
        .finally(() => { if (live) setBusy(""); });
    }
    return () => {
      live = false;
      invoke(page === "storage" ? "data:cancel-storage" : "data:cancel").catch(() => {});
    };
  }, [page, invoke]);
  async function run(method) {
    setBusy(method);
    setError("");
    setNotice("");
    try {
      const result = await invoke(method, { language });
      if (method === "data:clear-cache" || method === "data:storage") {
        setUsage(method === "data:storage" ? result : await invoke("data:storage"));
        if (method === "data:clear-cache") setNotice(t("已清理缓存。", "Cache cleared."));
      } else if (result?.path) setNotice(t("备份已保存到 ", "Backup saved to ") + result.path);
      else if (result?.restarting) setNotice(t("正在重启工作台…", "Restarting workspace…"));
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }
  const storage = page === "storage";
  const rows = [
    ["database", t("工作台数据库", "Workspace database")],
    ["attachments", t("附件快照", "Attachment snapshots")],
    ["workspaces", t("内置工作目录", "Managed working folders")],
    ["worktrees", t("Git 工作树", "Git worktrees")],
    ["profiles", t("原生工具配置和会话", "Native tool profiles and sessions")],
    ["other", t("其他应用数据和缓存", "Other app data and cache")],
  ];
  const action = (method, label, disabled = false) => <button type="button" className={storage ? "btn secondary" : "btn"} disabled={!!busy || disabled}
    onClick={() => run(method)}>{busy === method ? t("处理中…", "Working…") : label}</button>;
  return <div className="page-scroll"><article className="settings-page">
    <header className="settings-heading">
      <h1>{storage ? t("设备存储", "Device storage") : t("备份与恢复", "Backup & restore")}</h1>
      <p>{storage ? t("查看 BoTeam 在此设备上占用的空间。", "See how much space BoTeam uses on this device.") :
        t("在本机保存和恢复 BoTeam 工作台。", "Save and restore your BoTeam workspace locally.")}</p>
    </header>
    {storage ? <>
      <section>
        <div className="settings-section-heading"><h2 id="storage-usage-heading">{usage ? t("已使用 ", "Used ") + formatSize(usage.total, language) : t("存储用量", "Storage usage")}</h2>
          {action("data:storage", t("刷新", "Refresh"))}</div>
        {usage ? <>
          <div className="storage-bar" role="img" aria-labelledby="storage-usage-heading" aria-describedby="storage-legend">
            {rows.map(([key]) => <span key={key} data-storage-category={key}
              style={{ width: (usage.total ? usage[key] / usage.total * 100 : 0) + "%" }}/>)}
          </div>
          <ul className="storage-legend" id="storage-legend" aria-label={t("各类数据占用空间", "Space used by category")}>
            {rows.map(([key, label]) => <li key={key}>
              <span><i aria-hidden="true" data-storage-category={key}/>{label}</span>
              <small>{formatSize(usage[key], language)}</small>
            </li>)}
          </ul>
        </> : !error && <div className="storage-bar" role="progressbar" aria-label={t("正在计算存储用量", "Calculating storage usage")}/>}
      </section>
      <section><h2>{t("缓存", "Cache")}</h2><div className="settings-group"><div className="settings-row">
        <span className="row-copy"><strong>{t("可清理的应用缓存", "Clearable app cache")}{usage && " · " + formatSize(usage.cache, language)}</strong>
          <small>{t("清理可重新加载的网络资源。聊天、附件和登录状态会保留。", "Remove cached network resources. Chats, attachments and sign-ins are preserved.")}</small></span>
        {action("data:clear-cache", t("清理缓存", "Clear cache"), !usage)}
      </div></div></section>
    </> : <>
      <section><h2>{t("工作台备份", "Workspace backup")}</h2>
        <div className="settings-group"><div className="settings-row">
          <span className="row-copy"><strong>{t("导出备份", "Export backup")}</strong>
            <small>{t("将聊天、Bot、项目记录、定时任务、附件和内置工作目录的普通文件保存为 .boteam 文件。",
              "Save chats, bots, project records, schedules, attachments and regular files from managed working folders to a .boteam file.")}</small></span>
          {action("data:export", t("导出…", "Export…"))}
        </div><div className="settings-row">
          <span className="row-copy"><strong>{t("从备份恢复", "Restore from backup")}</strong>
            <small>{t("替换当前工作台并重启。恢复后请重新连接频道，检查并启用需要的定时任务。", "Replace the current workspace and restart. Reconnect channels and re-enable the schedules you need.")}</small></span>
          {action("data:restore", t("选择备份…", "Choose backup…"))}
        </div></div>
      </section>
      <section><h2>{t("备份范围", "Backup scope")}</h2><p className="settings-empty">
        {t("外部项目文件、Git 工作树、符号链接、原生会话、登录凭据和频道密钥由各自的工具管理。迁移到新设备后，请重新绑定订阅账号。",
          "External project files, Git worktrees, symbolic links, native sessions, sign-in credentials and channel keys are excluded. Reconnect subscription accounts when moving to a new device.")}</p></section>
    </>}
    {["data:export", "data:restore"].includes(busy) && <button type="button" className="btn"
      onClick={() => invoke("data:cancel", { language }).catch(e => setError(errorText(e)))}>
      {t("取消操作", "Cancel operation")}</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="settings-empty" role="status">{notice}</p>}
  </article></div>;
}
