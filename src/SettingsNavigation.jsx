import React, { useRef, useState } from "react";
import { Archive, Bell, Bot, Search, Settings, Sun, WalletCards, ScanLine, X } from "lucide-react";
import { useLanguage } from "./preferences";

const groups = [
  { title: ["Bot 管理", "Bots"], items: [
    ["bots", Bot, "我的 Bot", "My bots", "我的 Bot 名称 绑定订阅账号 创建 编辑 移除 默认模型 思考强度 推理强度 私聊 工作目录 name model reasoning effort bot directory"],
  ] },
  { title: ["账号管理", "Accounts"], items: [
    ["accounts", WalletCards, "订阅账号", "Subscription accounts", "订阅账号 添加 搜索 账号维护 备注 状态 绑定 Bot 重新授权 移除 CLI 登录 sign in subscription reauthorize"],
    ["local-accounts", ScanLine, "本机配置", "Local configurations", "检测 导入本机账号 订阅账号来源 授权 原生 CLI 登录 Codex Claude Code Antigravity import local accounts scan profiles"],
  ] },
  { title: ["应用", "App"], items: [
    ["general", Settings, "常规", "General", "界面语言 简体中文 英文 英语 English language"],
    ["appearance", Sun, "外观", "Appearance", "视觉样式 配色模式 主题 字号 字体大小 浅色 深色 暗色 夜间 跟随系统 visual style color mode theme font size light dark system"],
    ["notifications", Bell, "通知", "Notifications", "任务完成 运行失败 等待审批 定时任务 桌面提醒 approval failed complete schedule alerts"],
  ] },
  { title: ["数据与隐私", "Data & privacy"], items: [
    ["archived", Archive, "已归档会话", "Archived chats", "聊天 恢复 取消归档 永久删除 archive restore delete"],
  ] },
];
export const settingsPages = groups.flatMap(group => group.items.map(([id]) => id));

export function SettingsNavigation({ page, select, searchRef }) {
  const t = useLanguage();
  const [query, setQuery] = useState("");
  const results = useRef(null);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = groups.map(({title, items}) => ({
    title,
    items: items.filter(([, , zh, en, keywords]) => {
      const label = [...title, zh, en, keywords].join(" ").toLocaleLowerCase();
      return terms.every(term => label.includes(term));
    }),
  })).filter(group => group.items.length);
  function clear() { setQuery(""); searchRef.current?.focus(); }

  function openResult(id) {
    select(id);
    if (!terms.length) return;
    requestAnimationFrame(() => {
      const fields = document.querySelectorAll("main [data-setting-terms]");
      const field = Array.from(fields).find(el => terms.every(term => el.dataset.settingTerms.toLocaleLowerCase().includes(term)));
      field?.focus({ preventScroll: true });
      field?.scrollIntoView({ block: "nearest" });
    });
  }

  function navigateResult(event, fromSearch = false) {
    if (event.key === "Escape" && query) { event.preventDefault(); clear(); return; }
    const buttons = Array.from(results.current.querySelectorAll("button"));
    if (!buttons.length) return;
    if (fromSearch && event.key === "Enter" && terms.length) {
      event.preventDefault();
      const exact = buttons.find(button => button.textContent.toLocaleLowerCase() === query.trim().toLocaleLowerCase());
      (exact || buttons[0]).click();
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") buttons[Math.min(index + 1, buttons.length - 1)].focus();
    else if (index > 0) buttons[index - 1].focus();
    else searchRef.current.focus();
  }

  return <nav className="settings-navigation" aria-label={t("设置分类", "Settings categories")}>
    <header>
      <h2>{t("设置", "Settings")}</h2>
      <div className="settings-filter">
        <Search size={15} aria-hidden="true"/>
        <input ref={searchRef} autoFocus type="search" value={query} aria-label={t("搜索设置", "Search settings")}
          placeholder={t("搜索", "Search")} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => navigateResult(e, true)}/>
        {query && <button type="button" onClick={clear} aria-label={t("清除搜索", "Clear search")}><X size={13}/></button>}
      </div>
    </header>
    <div ref={results} className="settings-categories" onKeyDown={navigateResult}>
      {filtered.map(({title, items}) => <div key={title[1]} role="group" aria-label={t(...title)} className="settings-category">
        <p aria-hidden="true">{t(...title)}</p>
        {items.map(([id, Icon, zh, en]) => <button key={id} type="button" className="rail-row"
          aria-current={page === id ? "page" : undefined} onClick={() => openResult(id)}>
          <Icon size={16} aria-hidden="true"/><span>{t(zh, en)}</span>
        </button>)}
      </div>)}
      {!filtered.length && <p className="settings-no-results" role="status">{t("没有匹配的设置", "No matching settings")}</p>}
    </div>
  </nav>;
}
