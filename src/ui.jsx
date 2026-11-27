import { useLanguage } from "./preferences";
import React, { useEffect, useRef } from "react";
import codexIcon from "../assets/providers/codex.svg";
import claudeIcon from "../assets/providers/claude.svg";
import antigravityIcon from "../assets/providers/antigravity.svg";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Command,
  LoaderCircle,
  X,
} from "lucide-react";

export const providers = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
};
const providerIcons = { codex: codexIcon, claude: claudeIcon, antigravity: antigravityIcon };
export const providerName = (provider) =>
  providers[provider] || provider || "原生工具";
export const identityLabel = (account) =>
  account?.email ||
  (account?.identity?.startsWith("source:")
    ? "本机配置 · 身份待核实"
    : account?.identity) ||
  "身份待核实";
export const accountLabel = (account) =>
  account?.note || identityLabel(account);
export const needsAntigravityBinding = (account) =>
  account?.provider === "antigravity" &&
  account.status === "blocked" &&
  account.identity?.startsWith("source:");
export const errorText = (error) =>
  (error?.message || String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    "",
  );
const statusNames = {
  ready: ["可运行", "Ready"],
  login: ["需要登录", "Sign-in required"],
  missing: ["未安装", "Not installed"],
  blocked: ["执行受限", "Restricted"],
};

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      BoTeam
    </span>
  );
}
export function ProviderIcon({ provider, size = "normal" }) {
  const src = providerIcons[provider];
  return (
    <span className={`provider-icon ${provider || "unknown"} ${size}`} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : <Command />}
    </span>
  );
}
export function Status({ status, label }) {
  const tr = useLanguage();
  return (
    <span className={`status ${status || "unknown"}`}>
      <i />
      {label || tr(...(statusNames[status] || ["待核实", "Unverified"]))}
    </span>
  );
}
export function Spinner({ size = 15 }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}
export function Button({
  children,
  icon: Icon,
  busy = false,
  variant = "secondary",
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`btn ${variant} ${className}`}
    >
      {busy ? <Spinner /> : Icon && <Icon size={15} />} {children}
    </button>
  );
}
export function IconButton({ label, icon: Icon, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-btn ${props.className || ""}`}
      title={label}
      aria-label={label}
    >
      <Icon size={17} strokeWidth={1.7} />
    </button>
  );
}
export function Notice({ children }) {
  return children ? (
    <div className="notice" role="alert">
      <CircleAlert size={16} />
      <span>{children}</span>
    </div>
  ) : null;
}
export function Modal({ title, subtitle, children, onClose, wide = false }) {
  const tr = useLanguage();
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const selector =
      'button:enabled, input:enabled, select:enabled, textarea:enabled, [tabindex="0"]';
    (
      node.querySelector("[data-autofocus]") || node.querySelector(selector)
    )?.focus();
    function onKey(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = [...node.querySelectorAll(selector)].filter(
          (el) => el.offsetParent !== null,
        );
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1).focus();
        }
        if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0].focus();
        }
      }
    }
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-veil"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton icon={X} label={tr("关闭", "Close")} onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}
export function Field({ label, children, hint }) {
  return (
    <div className="field">
      <label>
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
export function Select({ children, ...props }) {
  return (
    <span className="select-wrap">
      <select {...props}>{children}</select>
      <ChevronDown size={15} />
    </span>
  );
}
export function MemberList({
  bots,
  accounts,
  selected,
  setSelected,
  multi = true,
  autoFocusFirst = false,
}) {
  return (
    <div className="member-list">
      {bots.map((bot, index) => {
        const account = accounts.find((x) => x.id === bot.accountId);
        const active = selected.includes(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            data-autofocus={(autoFocusFirst && index === 0) || undefined}
            aria-pressed={active}
            className={`member-row ${active ? "selected" : ""}`}
            onClick={() =>
              setSelected(
                multi
                  ? active
                    ? selected.filter((id) => id !== bot.id)
                    : [...selected, bot.id]
                  : [bot.id],
              )
            }
          >
            <ProviderIcon provider={account?.provider} />
            <span className="row-copy">
              <strong>{bot.name}</strong>
              <small>
                {providerName(account?.provider)} · {accountLabel(account)}
                {account?.note ? ` · ${identityLabel(account)}` : ""}
              </small>
            </span>
            <span
              className={`custom-check ${multi ? "" : "radio"} ${active ? "checked" : ""}`}
            >
              {active && <Check size={12} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
