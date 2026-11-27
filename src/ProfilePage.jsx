import React, { useEffect, useState } from "react";
import { Check, Copy, LockKeyhole, Pencil, Puzzle, Share } from "lucide-react";
import { usePreferences } from "./preferences";
import { Button, errorText, Field, Modal, Notice, Spinner } from "./ui";
import { describeModel } from "./NativeModelPicker";
import { ProfileAvatar } from "./ProfileAvatar";
import { ProfileActivity } from "./ProfileActivity";
import "./profile.css";

function formatDuration(ms, t) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return t(`${seconds} 秒`, `${seconds}s`);
  if (minutes < 60) return t(`${minutes} 分`, `${minutes}m`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [t(`${hours} 小时`, `${hours}h`), rest && t(`${rest} 分`, `${rest}m`)].filter(Boolean).join(" ");
}

function EditProfile({ onClose }) {
  const { profile, saveProfile, t } = usePreferences();
  const [name, setName] = useState(profile.displayName);
  const [handle, setHandle] = useState(profile.username);
  const [error, setError] = useState("");
  const username = handle.trim();
  const valid = name.trim() && username && !/[\s@]/u.test(username);

  function save(event) {
    event.preventDefault();
    if (!valid) return;
    try {
      saveProfile({ displayName: name.trim(), username });
      onClose();
    } catch (reason) { setError(errorText(reason)); }
  }
  return <Modal title={t("编辑个人资料", "Edit profile")} onClose={onClose}>
    <form onSubmit={save}>
      <Field label={t("显示名称", "Display name")}>
        <input data-autofocus required maxLength={60} value={name} onChange={e => setName(e.target.value)}/>
      </Field>
      <Field label={t("用户名", "Username")} hint={/[\s@]/u.test(username) && t("用户名中不能包含空格或 @。", "Use a username without spaces or @.")}>
        <input required maxLength={40} autoCapitalize="none" spellCheck={false}
          value={handle} onChange={e => setHandle(e.target.value.replace(/^@/, "").slice(0, 40))}/>
      </Field>
      <Notice>{error}</Notice>
      <div className="form-actions">
        <Button onClick={onClose}>{t("取消", "Cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!valid}>{t("保存", "Save")}</Button>
      </div>
    </form>
  </Modal>;
}

function ShareProfile({ summary, invoke, onClose }) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await invoke("copyProfileSummary", { text: summary });
      setCopied(true);
      setError("");
    } catch {
      setError(t("无法访问剪贴板，请选中摘要后复制。", "Clipboard unavailable. Select the summary to copy it."));
    }
  }
  return <Modal title={t("分享个人资料", "Share profile")} onClose={onClose}>
    <p className="profile-share-preview">{summary}</p>
    <Notice>{error}</Notice>
    <div className="form-actions">
      <Button variant="primary" icon={copied ? Check : Copy} onClick={copy}>
        <span aria-live="polite">{copied ? t("已复制", "Copied") : t("复制摘要", "Copy summary")}</span>
      </Button>
    </div>
  </Modal>;
}

export function ProfilePage({ state, invoke }) {
  const { profile, language, t } = usePreferences();
  const [dialog, setDialog] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  // Snapshots also change during streamed output. Reload just when recorded activity changes.
  const lastTaskChange = state.tasks.reduce((last, task) => {
    const date = task.completedAt || task.startedAt || task.createdAt;
    return date > last ? date : last;
  }, "");
  const lastUsageChange = (state.tokenMetrics || []).reduce((last, item) => item.updatedAt > last ? item.updatedAt : last, "");
  useEffect(() => {
    let active = true;
    setError("");
    invoke("profileStats").then(result => {
      if (active) setStats(result);
    }).catch(reason => {
      if (active) setError(errorText(reason));
    });
    return () => { active = false; };
  }, [invoke, state.tasks.length, lastTaskChange, lastUsageChange, attempt]);

  const number = new Intl.NumberFormat(language);
  const compact = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 });
  const days = value => t(`${number.format(value)} 天`, `${number.format(value)} ${value === 1 ? "day" : "days"}`);
  const metrics = stats ? [
    { label: t("累计 Token 数", "Total tokens"), value: compact.format(stats.totalTokens), detail: number.format(stats.totalTokens) },
    { label: t("Token 使用峰值", "Peak token usage"), value: compact.format(stats.peakTokens),
      detail: t("单日最高用量", "Highest daily usage") + " · " + number.format(stats.peakTokens) },
    { label: t("最长任务用时", "Longest task"), value: formatDuration(stats.longestTaskMs, t) },
    { label: t("最长连续天数", "Longest streak"), value: days(stats.longestStreak) },
    { label: t("当前连续天数", "Current streak"), value: days(stats.currentStreak) },
  ] : [];
  const topEffort = stats?.topEffort;
  const effort = topEffort && describeModel(null, null, topEffort.id, "codex", t).effortLabel;
  const insights = stats ? [
    [t("运行任务数", "Task runs"), number.format(stats.runCount)],
    [t("最常用的推理强度", "Most used reasoning effort"), topEffort ? `${effort} · ${topEffort.percent}%` : "—"],
    [t("已探索技能数", "Distinct skills used"), number.format(stats.uniqueSkills)],
    [t("使用的技能总数", "Total skill uses"), number.format(stats.skillUses)],
  ] : [];
  const identity = profile.displayName + "\n@" + profile.username;
  const summary = [identity, ...metrics.map(({ label, value }) => label + " · " + value)].join("\n");
  return <>
    <div className="profile-toolbar" data-scrolled={scrolled || undefined}>
      <button type="button" onClick={() => setDialog("edit")}><Pencil size={16}/>{t("编辑", "Edit")}</button>
      <span className="profile-visibility" title={t("个人资料仅在此设备上可见", "Your profile is only visible on this device")}>
        <LockKeyhole size={14}/>{t("私有", "Private")}
      </span>
      <button type="button" onClick={() => setDialog("share")}><Share size={16}/>{t("分享", "Share")}</button>
    </div>
    <div className="page-scroll profile-scroll" onScroll={e => setScrolled(e.currentTarget.scrollTop > 0)}>
      <article className="profile-page" aria-label={t("个人资料", "Profile")}>
        <header className="profile-identity">
          <ProfileAvatar className="profile-hero-avatar"/>
          <h1>{profile.displayName}</h1>
          <p>@{profile.username}</p>
        </header>
        {error && <div className="profile-load-error"><Notice>{error}</Notice>
          <Button onClick={() => setAttempt(value => value + 1)}>{t("重试", "Try again")}</Button>
        </div>}
        {!stats && !error && <div className="profile-loading" role="status" aria-label={t("正在读取统计", "Loading statistics")}><Spinner/></div>}
        {stats && <>
          <dl className="profile-metrics" aria-label={t("使用统计", "Usage statistics")}>
            {metrics.map(({ label, value, detail }) => <div key={label} title={detail}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}
          </dl>
          <section className="profile-section">
            <ProfileActivity daily={stats.dailyTokens}/>
            {stats.undatedTokens > 0 && <p className="profile-note">
              {t(`另有 ${number.format(stats.undatedTokens)} 个历史 Token 仅计入累计用量。`,
                `${number.format(stats.undatedTokens)} historical tokens are included only in total usage.`)}
            </p>}
          </section>
          <section className="profile-section">
            <h2>{t("热门插件", "Top plugins")}</h2>
            {stats.topPlugins.length ? <ul className="profile-plugins">
              {stats.topPlugins.map(plugin => <li key={plugin.id} title={t(`${plugin.count} 次使用`, `${plugin.count} uses`)}>
                <span className="profile-plugin-icon"><Puzzle size={25} strokeWidth={1.6}/></span>
                <span>{plugin.label}</span>
              </li>)}
            </ul> : <p className="profile-empty">{t("暂无插件使用记录", "No plugin activity yet")}</p>}
          </section>
          <section className="profile-section">
            <h2>{t("洞察", "Insights")}</h2>
            <dl className="profile-insights">
              {insights.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </section>
        </>}
      </article>
    </div>
    {dialog === "edit" && <EditProfile onClose={() => setDialog(null)}/>}
    {dialog === "share" && <ShareProfile summary={summary} invoke={invoke} onClose={() => setDialog(null)}/>}
  </>;
}
