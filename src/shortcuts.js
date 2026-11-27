export const defaultShortcuts = {
  newChat: "Mod+N",
  searchChats: "Mod+K",
  toggleSidebar: "Mod+B",
};

// Native menu commands, editor save, and the per-chat action shortcuts.
const reserved = new Set([
  "Mod+A", "Mod+C", "Mod+X", "Mod+V", "Mod+Z", "Mod+Y", "Mod+Shift+Z",
  "Mod+H", "Mod+Alt+H", "Mod+M", "Mod+Q", "Mod+S",
  "Mod+Alt+P", "Mod+Alt+R", "Mod+Shift+A", "Mod+Shift+U",
]);

export function shortcutFromEvent(event) {
  if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.getModifierState?.("AltGraph")) return "";
  const typed = event.key?.toUpperCase();
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
  const key = /^[A-Z0-9]$/.test(typed) ? typed : physical?.[1] || physical?.[2];
  return key ? ["Mod", event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+") : "";
}

export function supportedShortcut(value) {
  return typeof value === "string" && /^Mod\+(Alt\+)?(Shift\+)?[A-Z0-9]$/.test(value) && !reserved.has(value);
}

export function readShortcuts(value = {}) {
  const result = { ...defaultShortcuts };
  for (const id of Object.keys(result)) {
    const binding = value?.[id];
    if (binding === null || supportedShortcut(binding)) result[id] = binding;
  }
  const assigned = Object.values(result).filter(Boolean);
  return new Set(assigned).size === assigned.length ? result : { ...defaultShortcuts };
}

export function shortcutLabel(shortcut, mac = /Mac/i.test(navigator.platform)) {
  if (!shortcut) return "";
  return mac
    ? (shortcut.includes("Alt+") ? "⌥" : "") + (shortcut.includes("Shift+") ? "⇧" : "") + "⌘" + shortcut.at(-1)
    : shortcut.replace("Mod", "Ctrl");
}

// Accept key names and the symbols printed on a Mac keyboard in the search field.
export function searchChord(text) {
  const value = text.toLowerCase().trim()
    .replace(/command|cmd|control|ctrl|meta|⌘|⌃/g, "mod")
    .replace(/option|opt|⌥/g, "alt").replace(/⇧/g, "shift").replace(/[+\s]/g, "");
  const key = value.at(-1);
  if (!key || !/^[a-z0-9]$/.test(key)) return "";
  const modifiers = value.slice(0,-1).match(/mod|alt|shift/g) || [];
  if (!modifiers.includes("mod") || modifiers.join("") !== value.slice(0,-1)) return "";
  return ["Mod", modifiers.includes("alt") && "Alt", modifiers.includes("shift") && "Shift", key.toUpperCase()].filter(Boolean).join("+");
}
