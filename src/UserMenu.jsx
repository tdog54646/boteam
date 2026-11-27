import React, { useState } from "react";
import { Contrast, Globe, Type } from "lucide-react";
import { ActionMenu } from "./ActionMenu";
import { choices, usePreferences } from "./preferences";
import "./user-menu.css";

export function UserMenu() {
  const [anchor, setAnchor] = useState(null);
  const prefs = usePreferences();
  const { t } = prefs;
  const user = t("用户", "User");
  const initial = t("用", "U");
  const labels = {
    system: t("跟随系统", "System"),
    light: t("浅色", "Light"),
    dark: t("深色", "Dark"),
    small: t("小", "Small"),
    standard: t("标准", "Standard"),
    large: t("大", "Large"),
    "zh-CN": "简体中文",
    en: "English",
  };
  const sections = [
    ["theme", t("主题", "Theme"), Contrast],
    ["fontSize", t("字号", "Font size"), Type],
    ["language", t("语言", "Language"), Globe],
  ];
  const groups = [sections.map(([key, text, icon]) => ({
    id: key, text, icon,
    children: choices[key].map(value => ({
      id: key + "-" + value, text: labels[value], selected: prefs[key] === value,
      payload: { key, value },
    })),
  }))];
  return <>
    <button type="button" className="user-menu-trigger" aria-label={user}
      aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={e => setAnchor(anchor ? null : { anchor: e.currentTarget })}>
      <span className="local-user-avatar" aria-hidden="true">{initial}</span>
    </button>
    {anchor && <ActionMenu label={user} variant="user" anchor={anchor} groups={groups}
      heading={<><span className="local-user-avatar" aria-hidden="true">{initial}</span>{user}</>}
      onClose={() => setAnchor(null)} onAction={({ payload }) => prefs.update(payload.key, payload.value)} />}
  </>;
}
