import React, { useState } from "react";
import { choices, preferenceLabels, usePreferences } from "./preferences";
import { Select, Notice, errorText } from "./ui";
import { KeyboardShortcuts } from "./KeyboardShortcuts";

const headings = {
  general: ["常规", "General", "设置工作台的显示语言。", "Choose the language for your workspace."],
  appearance: ["外观", "Appearance", "选择工作台的主题和文字大小。", "Choose your workspace theme and text size."],
  notifications: ["通知", "Notifications", "选择哪些任务动态发送桌面通知。", "Choose which task updates appear as desktop notifications."],
};
const events = [
  ["completed", "任务完成", "Task completed", "Bot 完成一次对话任务时提醒。", "When a bot finishes a chat task."],
  ["failed", "运行失败", "Task failed", "对话任务执行失败时提醒。", "When a chat task fails."],
  ["approval", "等待审批", "Approval needed", "Bot 等待你批准工具或文件操作时提醒。", "When a bot needs approval to use a tool or access a file."],
  ["schedule", "定时任务结果", "Scheduled task results", "定时任务完成或失败时提醒。", "When a scheduled task finishes or fails."],
];

function SettingRow({ label, description, children }) {
  return <div className="settings-row">
    <div className="row-copy"><strong>{label}</strong>{description && <small>{description}</small>}</div>
    {children}
  </div>;
}

function ThemeChoices({ value, labels, onChange, t }) {
  return <div className="appearance-theme-choices" role="radiogroup" aria-label={t("主题", "Theme")}>
    {choices.theme.map(mode => <label key={mode} title={labels[mode]}>
      <input type="radio" name="appearance-theme" value={mode} aria-label={labels[mode]}
        checked={value === mode} onChange={() => onChange(mode)}
        data-setting-terms={value === mode ? "主题 配色模式 深色 浅色 跟随系统 theme color mode light dark system" : undefined}/>
      <span className="theme-preview" data-mode={mode} aria-hidden="true">
        {mode !== "dark" && <span className="theme-miniature light"/>}
        {mode !== "light" && <span className="theme-miniature dark"/>}
      </span>
      <span className="theme-caption" aria-hidden="true">{labels[mode]}</span>
    </label>)}
  </div>;
}

export function AppSettings({ page, state, invoke, refresh }) {
  const prefs = usePreferences();
  const { t } = prefs;
  const [pending, setPending] = useState({});
  const [error, setError] = useState("");
  if (page === "shortcuts") return <KeyboardShortcuts/>;
  const [zh, en, zhDescription, enDescription] = headings[page];
  const labels = preferenceLabels(t);

  function preference(key, label, detail) {
    return <SettingRow label={label} description={detail}>
      <Select aria-label={label} data-setting-terms={({
        language: "界面语言 简体中文 英文 English language",
        fontSize: "字号 字体大小 font size text size",
      })[key]} value={prefs[key]} onChange={e => prefs.update(key, e.target.value)}>
        {choices[key].map(value => <option key={value} value={value}>{labels[value]}</option>)}
      </Select>
    </SettingRow>;
  }
  async function toggle(type) {
    if (pending[type] != null) return;
    const enabled = !state.notifications?.[type];
    setPending(current => ({ ...current, [type]: enabled }));
    setError("");
    try {
      await invoke("setNotificationSetting", { type, enabled });
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setPending(current => ({ ...current, [type]: null })); }
  }
  return <div className="page-scroll"><article className={page === "appearance" ? "settings-page appearance-page" : "settings-page"}>
    <header className="settings-heading"><h1>{t(zh, en)}</h1><p>{t(zhDescription, enDescription)}</p></header>
    <section>
      <h2>{({general:t("语言", "Language"), appearance:t("视觉样式", "Visual style"),
        notifications:t("桌面提醒", "Desktop alerts")})[page]}</h2>
      <div className="settings-group">
        {page === "general" && preference("language", t("界面语言", "Display language"), t("用于菜单、按钮和设置页。", "Used for menus, buttons and settings."))}
        {page === "appearance" && <SettingRow label={t("配色模式", "Color mode")}
          description={t("跟随系统，或选择浅色或深色外观。", "Match your system or choose a light or dark appearance.")}>
          <ThemeChoices value={prefs.theme} labels={labels} onChange={mode => prefs.update("theme", mode)} t={t}/>
        </SettingRow>}
        {page === "notifications" && events.map(([type, zh, en, hintZh, hintEn]) =>
          <SettingRow key={type} label={t(zh, en)} description={t(hintZh, hintEn)}>
            <button className="settings-switch" type="button" role="switch" aria-label={t(zh,en)} data-setting-terms={[zh,en,hintZh,hintEn].join(" ")}
              aria-checked={pending[type] ?? Boolean(state.notifications?.[type])} aria-busy={pending[type] != null || undefined}
              aria-disabled={pending[type] != null || undefined} disabled={state.desktopNotificationsSupported === false}
              onClick={() => toggle(type)}><span/></button>
          </SettingRow>)}

      </div>
      {page === "notifications" && state.desktopNotificationsSupported === false &&
        <p className="settings-empty">{t("当前系统不支持桌面通知。", "This system does not support desktop notifications.")}</p>}
      <Notice>{error}</Notice>
    </section>
    {page === "appearance" && <section>
      <h2>{t("字体", "Fonts")}</h2>
      <div className="settings-group">
        {preference("fontSize", t("字号", "Font size"), t("调整工作台中的文字大小。", "Adjust the size of text in your workspace."))}
      </div>
    </section>}
  </article></div>;
}
