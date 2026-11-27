import React, { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { defaultShortcuts, readShortcuts } from "./shortcuts";

const storageKey = "boteam.user-preferences.v1";
export const choices = {
  theme: ["system", "light", "dark"],
  fontSize: ["small", "standard", "large"],
  language: ["zh-CN", "en"],
};
export function preferenceLabels(t) {
  return {
    system: t("跟随系统", "System"),
    light: t("浅色", "Light"),
    dark: t("深色", "Dark"),
    small: t("小", "Small"),
    standard: t("标准", "Standard"),
    large: t("大", "Large"),
    "zh-CN": "简体中文",
    en: "English",
  };
}
const defaultProfile = { displayName: "", username: "user" };
const defaults = { theme: "system", fontSize: "standard", language: "zh-CN", shortcuts: defaultShortcuts, profile: defaultProfile };
const fontScales = { small: 0.92, standard: 1, large: 1.15 };
const chinese = (zh) => zh;
const english = (zh, en) => en ?? zh;
const Preferences = createContext({ ...defaults, appearance: "light", fontScale: 1, t: chinese });

function readProfile(profile) {
  const displayName = typeof profile?.displayName === "string" ? profile.displayName.trim().slice(0, 60) : "";
  const username = typeof profile?.username === "string" ? profile.username.trim().replace(/^@+/, "").slice(0, 40) : "";
  return { displayName, username: username || defaultProfile.username };
}

function readPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey)) || {};
    return {
      ...Object.fromEntries(Object.entries(choices).map(([key, options]) =>
        [key, options.includes(stored[key]) ? stored[key] : defaults[key]])),
      shortcuts: readShortcuts(stored.shortcuts),
      profile: readProfile(stored.profile),
    };
  } catch { return defaults; }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
function subscribeSystem(callback) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export function PreferencesProvider({ children }) {
  const [prefs, setPrefs] = useState(readPreferences);
  const dark = useSyncExternalStore(subscribeSystem, systemDark);
  const appearance = prefs.theme === "system" ? (dark ? "dark" : "light") : prefs.theme;
  const fontScale = fontScales[prefs.fontSize];
  const t = prefs.language === "en" ? english : chinese;
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.lang = prefs.language;
    html.dataset.appearance = appearance;
    html.style.colorScheme = appearance;
    html.style.setProperty("--font-scale", fontScale);
  }, [prefs.language, appearance, fontScale]);
  useEffect(() => {
    const reload = (event) => {
      if (event.key === storageKey || event.key === null) setPrefs(readPreferences());
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);
  function persist(next) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    setPrefs(next);
  }
  function update(key, value) {
    if (choices[key]?.includes(value)) persist({ ...readPreferences(), [key]: value });
  }
  function setShortcut(id, value) {
    const next = readPreferences();
    const conflict = value && Object.entries(next.shortcuts).find(([other, key]) => other !== id && key === value);
    if (conflict) return conflict[0];
    persist({ ...next, shortcuts: { ...next.shortcuts, [id]: value } });
    return null;
  }
  function resetShortcuts() {
    persist({ ...readPreferences(), shortcuts: { ...defaultShortcuts } });
  }
  function saveProfile(profile) {
    const stored = readPreferences();
    const next = { ...stored, profile: readProfile({ ...stored.profile, ...profile }) };
    localStorage.setItem(storageKey, JSON.stringify(next));
    setPrefs(next);
  }
  const profile = { ...prefs.profile, displayName: prefs.profile.displayName || t("用户", "User") };
  return <Preferences.Provider value={{ ...prefs, profile, appearance, fontScale, t, update, setShortcut, resetShortcuts, saveProfile }}>{children}</Preferences.Provider>;
}

export const usePreferences = () => useContext(Preferences);
export const useLanguage = () => usePreferences().t;
