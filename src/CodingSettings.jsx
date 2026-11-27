import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { permissionInfo } from "./ComposerActionMenu";
import { useLanguage } from "./preferences";
import { Button, Notice, Select, errorText, providerName } from "./ui";

function PermissionRow({ title, provider, modes, value, target, inheritLabel, invoke, refresh }) {
  const t = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(event) {
    const permission = event.target.value || null;
    setError("");
    setBusy(true);
    try {
      await invoke("setDefaultPermission", { ...target, permission, expected: value });
      await refresh?.();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="settings-row">
      <div className="row-copy"><strong>{title}</strong>
        <small>{value ? permissionInfo(value, provider, t).detail : inheritLabel}</small>
      </div>
      <Select aria-label={t(`${title}的默认权限`, `Default permissions for ${title}`)}
        value={value ?? ""} onChange={change} disabled={busy}>
        <option value="">{inheritLabel}</option>
        {modes.map(mode => <option key={mode} value={mode}>{permissionInfo(mode, provider, t).title}</option>)}
      </Select>
    </div>
    <Notice>{error}</Notice>
  </>;
}

function ProjectSelect({ projects, project, onChange }) {
  const t = useLanguage();
  return <Select aria-label={t("选择项目", "Select project")} value={project.id} onChange={e => onChange(e.target.value)}>
    {projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
  </Select>;
}

function DefaultPermissions({ state, invoke, refresh, select, project, setProjectId }) {
  const t = useLanguage();
  const bots = state.bots.filter(bot => !bot.archived);
  const projectModes = state.projectPermissionDefaults || [];
  return <>
    <section>
      <h2>{t("Bot 默认权限", "Bot defaults")}</h2>
      <div className="settings-group">
        {bots.map(bot => {
          const provider = state.accounts.find(account => account.id === bot.accountId)?.provider;
          const value = state.botPermissionDefaults?.find(item => item.botId === bot.id)?.permission ?? null;
          return <PermissionRow key={bot.id} title={bot.name} provider={provider} modes={state.permissionModes?.[provider] || ["default"]}
            value={value} target={{ botId: bot.id }} inheritLabel={t("跟随原生工具", "Use CLI default")} invoke={invoke} refresh={refresh}/>;
        })}
        {!bots.length && <div className="settings-row"><span className="row-copy">{t("暂无 Bot", "No bots yet")}</span>
          <Button onClick={() => select("bots")}>{t("管理 Bot", "Manage bots")}</Button></div>}
      </div>
    </section>
    <section>
      <div className="settings-section-heading"><h2>{t("项目默认权限", "Project defaults")}</h2>
        {project && <ProjectSelect projects={state.projects} project={project} onChange={setProjectId}/>}</div>
      {project ? <div className="settings-group">
        {Object.entries(state.permissionModes || {}).map(([provider, modes]) =>
          <PermissionRow key={project.id + provider} title={providerName(provider)} provider={provider} modes={modes}
            value={projectModes.find(item => item.projectId === project.id && item.provider === provider)?.permission ?? null}
            target={{ projectId: project.id, provider }} inheritLabel={t("沿用 Bot 默认权限", "Use bot default")} invoke={invoke} refresh={refresh}/>)}
      </div> : <p className="settings-empty">{t("暂无项目", "No projects yet")}</p>}
    </section>
  </>;
}

function ProjectSettings({ page, state, project, setProjectId, invoke, open, select }) {
  const t = useLanguage();
  const directories = page === "directories";
  const projectId = project?.id;
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState(null);
  const chats = state.chats.filter(chat => chat.projectId === projectId);
  const chatIds = new Set(chats.map(chat => chat.id));
  const scope = JSON.stringify([page, projectId, project?.folders, version,
    chats.map(chat => [chat.id, chat.name, chat.members, chat.initialProjectCwd]),
    directories && state.nativeThreads?.filter(thread => chatIds.has(thread.chatId)).map(thread => [thread.chatId, thread.botId, thread.cwd]),
    directories && state.bots.map(bot => [bot.id, bot.name, bot.cwd]), directories && state.accounts.map(account => [account.id, account.cwd])]);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    invoke(directories ? "projectDirectories" : "projectWorktrees", { projectId })
      .then(data => { if (active) setResult({ scope, data }); })
      .catch(err => { if (active) setResult({ scope, error: errorText(err) }); });
    return () => { active = false; };
  }, [scope, invoke, projectId, directories]);
  const current = result?.scope === scope ? result : null;
  const data = current?.data;
  return <>
    {directories && <section>
      <h2>{t("Bot 默认目录", "Bot default directories")}</h2>
      <div className="settings-group"><div className="settings-row"><div className="row-copy">
        <strong>{t("Bot 工作目录", "Bot working directory")}</strong><small>{t("在 Bot 管理中查看和修改。", "View or edit each bot’s directory in Bots.")}</small>
      </div><Button onClick={() => select("bots")}>{t("Bot 管理", "Manage bots")}</Button></div></div>
    </section>}
    <section>
      <div className="settings-section-heading"><h2>{directories ? t("项目目录", "Project directories") : t("项目", "Project")}</h2>
        {project && <ProjectSelect projects={state.projects} project={project} onChange={setProjectId}/>}</div>
      {!project ? <p className="settings-empty">{t("暂无项目", "No projects yet")}</p> : <>
        {directories && <div className="settings-group"><div className="settings-row"><div className="row-copy">
          <strong>{t("项目默认目录", "Project default directory")}</strong><small>{project.folders[0]}</small>
        </div><Button onClick={() => open({ type: "project", id: project.id })}>{t("编辑项目", "Edit project")}</Button></div></div>}
        <div className="settings-section-heading">
          <h2>{directories ? t("会话实际生效目录", "Effective chat directories") : project.name}</h2>
          <Button icon={RefreshCw} disabled={!current} onClick={() => setVersion(value => value + 1)}>{t("刷新", "Refresh")}</Button>
        </div>
        <Notice>{current?.error}</Notice>
        {!current && <p className="settings-empty" role="status">{t("正在读取…", "Loading…")}</p>}
        {data && directories && <div className="settings-group">
          {data.length ? data.map(row => <div className="settings-row" key={JSON.stringify([row.chatId, row.directory])}>
            <div className="row-copy"><strong>{row.chatName} · {row.names.join("、")}</strong><small>{row.directory}</small></div>
          </div>) : <p className="settings-empty">{t("此项目暂无会话。新会话使用项目默认目录。", "No chats yet. New chats use the project default directory.")}</p>}
        </div>}
        {data && !directories && <>
          {data.issues.map(issue => <Notice key={issue.path}>{issue.path} · {issue.message}</Notice>)}
          <div className="settings-group">{data.rows.map(row => <div className="settings-row" key={row.path}><div className="row-copy">
            <strong>{row.branch || (row.bare ? t("裸仓库", "Bare repository") : t("分离的 HEAD", "Detached HEAD"))}
              {row.commit && " · " + row.commit.slice(0,8)}{row.locked && t(" · 已锁定", " · Locked")}{row.prunable && t(" · 可清理", " · Prunable")}</strong>
            <small>{row.path}</small>
          </div></div>)}
          {!data.rows.length && !data.issues.length && <p className="settings-empty">{t("此项目的源文件夹没有 Git 工作树。", "No Git worktrees found in the project folders.")}</p>}</div>
        </>}
      </>}
    </section>
  </>;
}

export function CodingSettings({ page, state, invoke, open, select, refresh }) {
  const t = useLanguage();
  const [projectId, setProjectId] = useState("");
  const project = state.projects.find(item => item.id === projectId) || state.projects[0];
  const copy = {
    permissions: [t("工具审批与文件访问", "Tool & file permissions"), t("会话单独设置的权限优先，其次使用项目默认权限，再使用 Bot 默认权限。", "Chat overrides take precedence, followed by the project default and the bot default.")],
    directories: [t("工作目录", "Working directories"), t("查看项目新会话的默认目录和已有会话实际使用的目录。", "See the default directory for new project chats and the directories used by existing chats.")],
    worktrees: [t("Git 工作树", "Git worktrees"), t("查看项目仓库的工作树。可在聊天菜单中创建工作树分支。", "Inspect the project’s Git worktrees. Create a worktree fork from a chat menu.")],
  };
  const [title, description] = copy[page];
  return <div className="page-scroll"><article className="settings-page"><header className="settings-heading">
    <h1>{title}</h1><p>{description}</p>
  </header>
    {page === "permissions"
      ? <DefaultPermissions {...{state, invoke, refresh, select, project, setProjectId}}/>
      : <ProjectSettings {...{page, state, project, setProjectId, invoke, open, select}}/>}
  </article></div>;
}
