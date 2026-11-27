import React, { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

const storageKey = "boteam.user-preferences.v1";
export const choices = {
  theme: ["system", "light", "dark"],
  fontSize: ["small", "standard", "large"],
  language: ["zh-CN", "en"],
};
const defaults = { theme: "system", fontSize: "standard", language: "zh-CN" };
const fontScales = { small: 0.92, standard: 1, large: 1.15 };
const chinese = (zh) => zh;
const english = (zh, en) => en ?? zh;
const Preferences = createContext({ ...defaults, appearance: "light", fontScale: 1, t: chinese });

function readPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey)) || {};
    return Object.fromEntries(Object.entries(choices).map(([key, options]) =>
      [key, options.includes(stored[key]) ? stored[key] : defaults[key]]));
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
  function update(key, value) {
    if (!choices[key]?.includes(value)) return;
    const next = { ...prefs, [key]: value };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    setPrefs(next);
  }
  return <Preferences.Provider value={{ ...prefs, appearance, fontScale, t, update }}>{children}</Preferences.Provider>;
}

export const usePreferences = () => useContext(Preferences);
export const useLanguage = () => usePreferences().t;
