import React, { useRef, useState } from "react";
import { Pencil, Search, Trash2 } from "lucide-react";
import { ShortcutSymbol } from "./ui";
import { usePreferences } from "./preferences";
import { defaultShortcuts, searchChord, shortcutFromEvent, shortcutLabel, supportedShortcut } from "./shortcuts";

const commands = [
  ["newChat", "新建对话", "New chat", "开始与默认 Bot 的新对话", "Start a new chat with the default bot"],
  ["searchChats", "搜索聊天", "Search chats", "按名称或消息内容查找对话", "Find chats by name or message content"],
  ["toggleSidebar", "展开或收起侧栏", "Toggle sidebar", "显示或隐藏当前页面的侧栏", "Show or hide the sidebar for the current page"],
];
const titles = Object.fromEntries(commands.map(([id, zh, en]) => [id, [zh, en]]));

export function KeyboardShortcuts() {
  const { t, shortcuts, setShortcut, resetShortcuts } = usePreferences();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState("");
  const [notice, setNotice] = useState("");
  const search = useRef(null);
  const findByChord = searchChord(query);
  const term = query.trim().toLowerCase();
  const items = commands.filter(([id, ...words]) => {
    if (findByChord) return shortcuts[id] === findByChord;
    const key = shortcuts[id] ? shortcutLabel(shortcuts[id]) : t("未分配", "Unassigned");
    return [...words, key].join(" ").toLowerCase().includes(term);
  });
  const mac = /Mac/i.test(navigator.platform);
  const prompt = t("请按下快捷键", "Press shortcut");
  function stop() {
    setRecording(""); setNotice("");
  }
  function start(id) {
    setNotice("");
    if (id === "search") setQuery("");
    setRecording(recording === id ? "" : id);
  }
  function capture(event, id) {
    if (recording !== id || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { stop(); return; }
    if (event.repeat || ["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    const binding = shortcutFromEvent(event);
    if (!binding) {
      setNotice(mac ? t("请按住 ⌘，再按字母或数字键。", "Hold ⌘ and press a letter or number.")
        : t("请按住 Ctrl，再按字母或数字键。", "Hold Ctrl and press a letter or number."));
      return;
    }
    if (id === "search") {
      setQuery(shortcutLabel(binding)); stop(); search.current?.focus();
      return;
    }
    if (!supportedShortcut(binding)) {
      setNotice(t("此组合键已有系统或工作台操作，请选择其他组合。", "This combination is already used by the system or workspace."));
      return;
    }
    const conflict = setShortcut(id, binding);
    if (conflict) {
      setNotice(t("此快捷键已用于", "This shortcut is assigned to ") + t(...titles[conflict]));
      return;
    }
    stop();
  }

  const captureHandlers = id => ({
    "aria-pressed": recording === id,
    onClick: e => { e.currentTarget.focus(); start(id); },
    onKeyDown: e => capture(e, id),
    onBlur: () => { if (recording === id) stop(); },
  });
  const customized = commands.some(([id]) => shortcuts[id] !== defaultShortcuts[id]);
  return <div className="page-scroll"><article className="settings-page shortcuts-page">
    <header className="settings-heading">
      <h1>{t("键盘快捷键", "Keyboard shortcuts")}</h1>
      <p>{t("查看并更改键盘快捷键", "View and change keyboard shortcuts")}</p>
    </header>
    <div className="shortcuts-search-bar"><div className="shortcuts-search">
      <Search size={15} aria-hidden="true"/>
      <input type="search" ref={search} aria-label={t("搜索快捷键", "Search shortcuts")} value={query}
        placeholder={recording === "search" ? prompt : t("搜索快捷键", "Search shortcuts")}
        onChange={e => setQuery(e.target.value)}/>
      <button type="button" className="shortcut-record" aria-label={t("按组合键搜索", "Search by key combination")}
        title={t("按组合键搜索", "Search by key combination")} {...captureHandlers("search")}><ShortcutSymbol size={16}/></button>
    </div></div>
    <div className="shortcuts-defaults">
      <div className="shortcuts-copy"><strong>{t("默认快捷键", "Default shortcuts")}</strong>
        <small>{t("恢复 BoTeam 的默认按键组合", "Restore BoTeam’s default key combinations")}</small></div>
      <button type="button" className="shortcut-reset" disabled={!customized} onClick={resetShortcuts}>{t("恢复默认", "Restore defaults")}</button>
    </div>
    <section className="shortcuts-list" aria-label={t("工作台快捷键", "Workspace shortcuts")}>
      {items.map(([id, zh, en, zhDescription, enDescription]) => {
        const title = t(zh, en);
        const edit = t("编辑快捷键", "Edit shortcut") + " · " + title;
        const remove = t("移除快捷键", "Remove shortcut") + " · " + title;
        return <div className="shortcuts-row" key={id}>
          <div className="shortcuts-copy"><strong>{title}</strong><small>{t(zhDescription,enDescription)}</small></div>
          <div className="shortcuts-binding">
            {recording === id ? <span className="shortcut-keycap" role="status">{prompt}</span>
              : shortcuts[id] ? <kbd className="shortcut-keycap">{shortcutLabel(shortcuts[id])}</kbd>
              : <span className="shortcut-unassigned">{t("未分配", "Unassigned")}</span>}
            <button type="button" className="shortcut-edit" aria-label={edit} title={edit} {...captureHandlers(id)}><Pencil size={14}/></button>
          </div>
          <button type="button" className="shortcut-remove" disabled={!shortcuts[id]}
            aria-label={remove} title={remove} onClick={() => { setShortcut(id,null); stop(); }}><Trash2 size={14}/></button>
        </div>;
      })}
      {!items.length && <p className="settings-empty" role="status">{t("没有匹配的快捷键", "No matching shortcuts")}</p>}
    </section>
    {notice && <p className="shortcuts-notice" role="alert">{notice}</p>}
  </article></div>;
}
